import {
  TransactionType,
  TransactionStatus,
} from "@reservoir0x/lighter-ts-sdk";
import {
  buildLighterTransferL1Message,
  DecodedLighterVmWithdrawal,
  decodeWithdrawal,
  DepositoryWithdrawalMessage,
  DepositoryWithdrawalStatus,
  getDecodedWithdrawalId,
  getVmTypeNativeCurrency,
} from "@relay-protocol/settlement-sdk";
import axios from "axios";
import { keccak256, stringToHex, zeroHash } from "viem";

import { getDeterministicId } from "../../utils";
import { EnhancedDepositoryDepositMessage, VmAttestor } from "../types";
import { Chain, getChain } from "../../../../common/chains";
import { externalError, internalError } from "../../../../common/error";
import { getTrackingId, logRpcUsage } from "../../../../common/rpc-usage";
import { httpRpc } from "../../../../common/vm/lighter-vm/rpc";
import { logger } from "../../../../common/logger";

const VM_TYPE = "lighter-vm";

// Buffer for ExpiredAt check to account for clock skew (60 seconds)
const EXPIRY_BUFFER_MS = 60 * 1000;

type TransferTxInfo = {
  FromAccountIndex: number;
  ApiKeyIndex: number;
  ToAccountIndex: number;
  AssetIndex: number;
  FromRouteType: number;
  ToRouteType: number;
  Amount: number;
  USDCFee: number;
  Memo: number[];
  ExpiredAt: number;
  Nonce: number;
  Sig: string;
  L1Sig: string;
};

// Explorer API log entry shape
interface ExplorerTransferPubdata {
  from_account_index: string;
  to_account_index: string;
}

interface ExplorerLogEntry {
  hash: string;
  status: string;
  pubdata?: {
    l2_transfer_pubdata?: ExplorerTransferPubdata;
    l2_transfer_pubdata_v2?: ExplorerTransferPubdata;
  };
}

export class LighterVmAttestor extends VmAttestor {
  public async getDepositoryDepositMessages(
    chainId: string,
    transactionId: string,
  ): Promise<EnhancedDepositoryDepositMessage[]> {
    const trackingId = getTrackingId();

    const chain = await getChain(chainId);
    const depositories = this._getConfiguredDepositories(chain);

    const { transactionApi } = await httpRpc(chainId);

    // Get transaction details
    await logRpcUsage(chainId, "getTransaction", trackingId);
    const txDetail = await transactionApi.getTransaction({
      by: "hash",
      value: transactionId,
    });
    if (!txDetail) {
      throw externalError(
        `Missing transaction ${transactionId} on chain ${chainId}`,
      );
    }

    // Check transaction status
    if (
      txDetail.status !== TransactionStatus.COMMITTED &&
      txDetail.status !== TransactionStatus.EXECUTED
    ) {
      throw externalError(`Missing or reverted transaction ${transactionId}`);
    }

    // Only Transfer transactions can be deposits
    if (txDetail.type !== TransactionType.TRANSFER) {
      return [];
    }

    if (!txDetail.info) {
      return [];
    }

    const transferInfo: TransferTxInfo = JSON.parse(txDetail.info);

    // Check direction — deposit = Transfer TO a configured depository,
    // not from the same depository itself.
    const fundedDepository = depositories.find(
      (d) => BigInt(transferInfo.ToAccountIndex) === d.accountIndex,
    );
    if (!fundedDepository) {
      return [];
    }
    if (
      BigInt(transferInfo.FromAccountIndex) === fundedDepository.accountIndex
    ) {
      return [];
    }

    // Map currency — always attest deposits regardless of asset/route combo
    // (recovery flows need attestation even for unexpected currencies)
    const transferCurrency = this._getDepositCurrency(transferInfo);

    if (!txDetail.queued_at) {
      throw externalError(
        `Missing queued_at for transaction ${transactionId}`,
      );
    }
    const timestamp = Math.floor(txDetail.queued_at / 1000).toString();

    return [
      {
        data: {
          chainId,
          transactionId,
        },
        result: {
          onchainId: getDeterministicId(chainId, transactionId, "0"),
          depository: fundedDepository.address,
          depositId: this._getDepositId(transferInfo.Memo),
          depositor: transferInfo.FromAccountIndex.toString(),
          currency: transferCurrency,
          amount: transferInfo.Amount.toString(),
        },
        extraData: {
          timestamp,
        },
      },
    ];
  }

  public async getDepositoryWithdrawalMessage(
    chainId: string,
    withdrawal: string,
    transactionId?: string,
  ): Promise<DepositoryWithdrawalMessage> {
    const trackingId = getTrackingId();

    const chain = await getChain(chainId);

    const decodedWithdrawal = decodeWithdrawal(
      withdrawal,
      chain.vmType,
    ) as DecodedLighterVmWithdrawal;
    const withdrawalId = getDecodedWithdrawalId(decodedWithdrawal);
    const { parameters } = decodedWithdrawal.withdrawal;
    const depository = this._getConfiguredDepository(
      chain,
      parameters.fromAccountIndex,
    ).address;

    let status: DepositoryWithdrawalStatus = DepositoryWithdrawalStatus.PENDING;

    const { transactionApi } = await httpRpc(chainId);

    // 1. Scan recent depository Transfer txs via Explorer API
    const explorerApiUrl = chain.additionalData?.explorerApiUrl;
    const PAGE_SIZE = 100;
    const MAX_PAGES = 3;
    let found = false;
    let rpcCallCount = 0;

    for (let page = 0; page < MAX_PAGES && !found && explorerApiUrl; page++) {
      try {
        await logRpcUsage(chainId, "explorerAccountLogs", trackingId);
        const response: { data: ExplorerLogEntry[] } = await axios.get(
          `${explorerApiUrl}/accounts/${depository}/logs` +
            `?pub_data_type=L2Transfer%2CL2TransferV2&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
          {
            headers: {
              // Cloudfront will block the request unless a user-agent header is present
              "User-Agent":
                "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0",
            },
            timeout: 10000,
          },
        );

        const logs: ExplorerLogEntry[] = response.data;
        if (!logs?.length) break;

        for (const log of logs) {
          // Pre-filter by pubdata: only txs FROM depository TO withdrawal recipient
          const pd =
            log.pubdata?.l2_transfer_pubdata ||
            log.pubdata?.l2_transfer_pubdata_v2;
          if (
            !pd ||
            pd.from_account_index !== depository ||
            pd.to_account_index !== parameters.toAccountIndex
          ) {
            continue;
          }

          // Full tx detail needed for L1 message hash matching
          rpcCallCount++;
          await logRpcUsage(chainId, "getTransaction", trackingId);
          const txDetail = await transactionApi.getTransaction({
            by: "hash",
            value: log.hash,
          });
          if (
            txDetail?.type === TransactionType.TRANSFER &&
            txDetail.info
          ) {
            const transferInfo: TransferTxInfo = JSON.parse(txDetail.info);
            const txMsgHash = this._getTransferMessageHash(
              transferInfo,
              parameters.lighterChainId,
            );
            if (txMsgHash === withdrawalId) {
              if (log.status === "executed") {
                // Explorer confirms executed → EXECUTED directly
                status = DepositoryWithdrawalStatus.EXECUTED;
              } else {
                // Non-executed → use getTransaction status for granular check
                status = this._getWithdrawalStatus(
                  txDetail.status,
                  transferInfo,
                );
              }
              found = true;
              break;
            }
          }
        }
      } catch (error) {
        logger.warn(
          "lighter-vm",
          `Explorer API error during withdrawal scan: ${error}`,
        );
        break;
      }
    }

    if (rpcCallCount > 0) {
      logger.info(
        "lighter-vm",
        `Withdrawal scan: ${rpcCallCount} getTransaction calls, found=${found}`,
      );
    }

    // 2. Fallback: transactionId provided → direct lookup
    if (status === DepositoryWithdrawalStatus.PENDING && transactionId) {
      await logRpcUsage(chainId, "getTransaction", trackingId);
      const txDetail = await transactionApi.getTransaction({
        by: "hash",
        value: transactionId,
      });
      if (
        txDetail?.type === TransactionType.TRANSFER &&
        txDetail.info
      ) {
        const transferInfo: TransferTxInfo = JSON.parse(txDetail.info);
        const txMsgHash = this._getTransferMessageHash(
          transferInfo,
          parameters.lighterChainId,
        );
        if (txMsgHash === withdrawalId) {
          status = this._getWithdrawalStatus(txDetail.status, transferInfo);
        }
      }
    }

    return {
      data: {
        chainId,
        withdrawal,
      },
      result: {
        withdrawalId,
        depository,
        status,
      },
    };
  }

  public async getSolverPaidAmount(
    chainId: string,
    transactionId: string,
    payment: {
      currency: string;
      recipient: string;
      orderId: string;
      extraData: string;
      deadline: number;
    },
  ): Promise<bigint> {
    const trackingId = getTrackingId();

    const { transactionApi } = await httpRpc(chainId);

    // Get transaction details
    await logRpcUsage(chainId, "getTransaction", trackingId);
    const txDetail = await transactionApi.getTransaction({
      by: "hash",
      value: transactionId,
    });
    if (!txDetail) {
      throw externalError(
        `Missing transaction ${transactionId} on chain ${chainId}`,
      );
    }

    // Check transaction status
    if (
      txDetail.status !== TransactionStatus.COMMITTED &&
      txDetail.status !== TransactionStatus.EXECUTED
    ) {
      throw externalError(`Missing or reverted transaction ${transactionId}`);
    }

    // Check transaction deadline
    if (!txDetail.queued_at) {
      throw externalError(`Missing or reverted transaction ${transactionId}`);
    }
    const transactionTimestamp = Math.floor(txDetail.queued_at / 1000);
    if (transactionTimestamp > payment.deadline) {
      throw externalError(
        `Transaction ${transactionId} executed after deadline`,
      );
    }

    // Verify payment
    if (txDetail.type !== TransactionType.TRANSFER) {
      throw externalError("Could not detect payment");
    }

    // Parse and verify transaction info
    let transferInfo: TransferTxInfo;
    if (!txDetail.info) {
      throw externalError("Could not detect payment");
    }
    transferInfo = JSON.parse(txDetail.info);

    if (
      Buffer.from(transferInfo.Memo).toString("hex") !==
      payment.orderId.slice(2)
    ) {
      throw externalError(
        `Transaction ${transactionId} does not reference order id`,
      );
    }

    let transferCurrency: string;
    if (transferInfo.AssetIndex === 1) {
      // ETH
      if (transferInfo.ToRouteType !== 1) {
        throw externalError("Could not detect payment");
      }
      // Spot ETH
      transferCurrency = transferInfo.AssetIndex.toString();
    } else if (transferInfo.AssetIndex === 3) {
      // USDC
      if (transferInfo.ToRouteType === 0) {
        // Perps USDC
        transferCurrency = getVmTypeNativeCurrency(VM_TYPE);
      } else if (transferInfo.ToRouteType === 1) {
        // Spot USDC
        transferCurrency = transferInfo.AssetIndex.toString();
      } else {
        throw externalError("Could not detect payment");
      }
    } else {
      throw externalError("Could not detect payment");
    }

    if (payment.currency !== transferCurrency) {
      throw externalError("Could not detect payment");
    }

    // Verify the recipient matches
    const recipientAccountIndex = parseInt(payment.recipient);
    if (
      isNaN(recipientAccountIndex) ||
      transferInfo.ToAccountIndex !== recipientAccountIndex
    ) {
      throw externalError("Could not detect payment");
    }

    return BigInt(transferInfo.Amount);
  }

  public async verifySolverCalls(
    _chainId: string,
    _transactionId: string,
    _calls: string[],
    _extraData: string,
  ): Promise<boolean> {
    throw internalError("Not implemented (verifySolverCalls)");
  }

  private _getConfiguredDepositories(chain: Chain) {
    const depository = chain.depository;
    if (!depository) {
      throw externalError("Chain has no depository configured");
    }

    return [depository, ...(chain.additionalDepositories ?? [])].map(
      (address) => ({
        address,
        accountIndex: this._parseDepositoryAccountIndex(address),
      }),
    );
  }

  private _getConfiguredDepository(chain: Chain, accountIndex: string) {
    const parsedAccountIndex = this._parseDepositoryAccountIndex(accountIndex);
    const depository = this._getConfiguredDepositories(chain).find(
      (d) => d.accountIndex === parsedAccountIndex,
    );
    if (!depository) {
      throw externalError(
        `Depository ${accountIndex} is not configured for chain ${chain.id}`,
      );
    }

    return depository;
  }

  private _parseDepositoryAccountIndex(accountIndex: string): bigint {
    if (!/^\d+$/.test(accountIndex)) {
      throw externalError(`Invalid depository account index: ${accountIndex}`);
    }

    return BigInt(accountIndex);
  }

  /**
   * Map TransferTxInfo to a currency string for deposits.
   * Always returns a value — deposits must be attested regardless of currency
   * (recovery flows need attestation even for unexpected asset/route combos).
   */
  private _getDepositCurrency(info: TransferTxInfo): string {
    if (info.AssetIndex === 3 && info.ToRouteType === 0) {
      // Perps USDC = native currency
      return getVmTypeNativeCurrency(VM_TYPE);
    }
    // All other combos: use assetIndex as currency identifier
    return info.AssetIndex.toString();
  }

  /**
   * Extract depositId from Memo bytes.
   * Valid Relay orderId = 32-byte keccak256 hash. Non-Relay memos (SDK-padded
   * short strings, fast withdrawal 20-byte address) have last 12 bytes as zero.
   */
  private _getDepositId(memo: number[]): string {
    if (memo.length !== 32) {
      return zeroHash;
    }
    // Last 12 bytes all zero = non-Relay memo, fall back to zeroHash.
    for (let i = 20; i < 32; i++) {
      if (memo[i] !== 0) {
        return `0x${Buffer.from(memo).toString("hex")}`;
      }
    }
    return zeroHash;
  }

  /**
   * Determine withdrawal status from getTransaction status + ExpiredAt.
   * Used when Explorer status alone isn't sufficient (non-"executed" logs).
   */
  private _getWithdrawalStatus(
    txStatus: number | string,
    transferInfo: TransferTxInfo,
  ): DepositoryWithdrawalStatus {
    if (
      txStatus === TransactionStatus.EXECUTED ||
      txStatus === TransactionStatus.COMMITTED
    ) {
      return DepositoryWithdrawalStatus.EXECUTED;
    }
    if (
      txStatus === TransactionStatus.FAILED ||
      txStatus === TransactionStatus.REJECTED
    ) {
      return DepositoryWithdrawalStatus.EXPIRED;
    }
    // PENDING/QUEUED — check if past deadline
    if (
      transferInfo.ExpiredAt &&
      Date.now() > transferInfo.ExpiredAt + EXPIRY_BUFFER_MS
    ) {
      return DepositoryWithdrawalStatus.EXPIRED;
    }
    return DepositoryWithdrawalStatus.PENDING;
  }

  /**
   * Reconstruct the L1 message hash from a TransferTxInfo.
   * This produces the same hash as getDecodedWithdrawalId() for matching withdrawals.
   */
  private _getTransferMessageHash(
    info: TransferTxInfo,
    lighterChainId: string,
  ): string {
    const l1Message = buildLighterTransferL1Message({
      type: "Transfer",
      nonce: info.Nonce.toString(),
      fromAccountIndex: info.FromAccountIndex.toString(),
      fromRouteType: info.FromRouteType.toString(),
      apiKeyIndex: info.ApiKeyIndex.toString(),
      toAccountIndex: info.ToAccountIndex.toString(),
      toRouteType: info.ToRouteType.toString(),
      assetIndex: info.AssetIndex.toString(),
      amount: info.Amount.toString(),
      usdcFee: info.USDCFee.toString(),
      lighterChainId,
      memo: Buffer.from(info.Memo).toString("hex").padEnd(64, "0"),
    });

    return keccak256(stringToHex(l1Message));
  }
}

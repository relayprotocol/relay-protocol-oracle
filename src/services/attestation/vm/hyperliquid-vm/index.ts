import * as hl from "@nktkas/hyperliquid";
import {
  DecodedHyperliquidVmWithdrawal,
  decodeWithdrawal,
  DepositoryWithdrawalMessage,
  DepositoryWithdrawalStatus,
  getDecodedWithdrawalId,
  getVmTypeNativeCurrency,
} from "@relay-protocol/settlement-sdk";
import axios from "axios";
import { parseUnits, hashStruct, zeroHash } from "viem";

import { getDeterministicId } from "../utils";
import { EnhancedDepositoryDepositMessage, VmAttestor } from "../../vm/types";
import { TxHints } from "../../../attestation";
import { getChain } from "../../../../common/chains";
import { externalError, internalError } from "../../../../common/error";
import { httpRpc } from "../../../../common/vm/hyperliquid-vm/rpc";
import { getTrackingId, logRpcUsage } from "../../../../common/rpc-usage";
import { logger } from "../../../../common/logger";

const VM_TYPE = "hyperliquid-vm";

const SPOT_USDC = "0x6d1e7cde53ba9467b783cb7c530ce054";

const getTxDetailsWithFallback = async (
  chainId: string,
  txId: string,
  trackingId: string,
  hints?: TxHints,
): Promise<Omit<hl.TxDetailsResponse["tx"], "block">> => {
  const rpc = await httpRpc(chainId);

  // If tx hints are provided, we use the `userNonFundingLedgerUpdates` API to get the transaction details.
  // That API is much less restrictive compared to the usual `txDetails` API.
  if (hints?.["hyperliquid-vm"]) {
    await logRpcUsage(chainId, "userNonFundingLedgerUpdates", trackingId);
    const ledgerUpdates = await rpc.userNonFundingLedgerUpdates({
      user: hints["hyperliquid-vm"].user as `0x${string}`,
      startTime: hints["hyperliquid-vm"].timestamp,
      endTime: hints["hyperliquid-vm"].timestamp,
    });

    const txEntry = ledgerUpdates.find(
      (u) => u.hash.toLowerCase() === txId.toLowerCase(),
    );
    if (txEntry) {
      const delta = txEntry.delta as any;
      if (delta.type === "send") {
        await logRpcUsage(chainId, "spotMeta", trackingId);
        const tokenId = await rpc
          .spotMeta()
          .then((r) => r.tokens.find((t) => t.name === delta.token)?.tokenId);
        if (tokenId) {
          logger.info(
            "hyperliquid-vm-debug",
            JSON.stringify({
              msg: "Using userNonFundingLedgerUpdates entry",
              details: {
                action: {
                  type: "sendAsset",
                  destination: delta.destination,
                  token: `${delta.token}:${tokenId}`,
                  sourceDex: delta.sourceDex,
                  destinationDex: delta.destinationDex,
                  amount: delta.amount,
                  nonce: delta.nonce,
                },
                user: delta.user,
                time: txEntry.time,
                hash: txEntry.hash,
                error: null,
              },
            }),
          );
          return {
            action: {
              type: "sendAsset",
              destination: delta.destination,
              token: `${delta.token}:${tokenId}`,
              sourceDex: delta.sourceDex,
              destinationDex: delta.destinationDex,
              amount: delta.amount,
              nonce: delta.nonce,
            },
            user: delta.user,
            time: txEntry.time,
            hash: txEntry.hash,
            error: null,
          };
        }
      }
    }
  }

  await logRpcUsage(chainId, "txDetails", trackingId);
  return rpc
    .txDetails({
      hash: txId as any,
    })
    .then((tx) => tx?.tx)
    .catch(async (error) => {
      if (
        (error as any).body ===
          "More than 100 archived blocks queried in one day" ||
        (error as any).stack?.startsWith(
          "HttpRequestError: 429 Too Many Requests",
        )
      ) {
        return axios
          .post(
            "https://nfttools.pro",
            {
              type: "txDetails",
              hash: txId,
            },
            {
              headers: {
                "X-Nft-Api-Key": "039f6b70-3799-40a1-afd7-63087faddaed",
                url: "https://rpc.hyperliquid.xyz/explorer",
              },
            },
          )
          .then((response) => response.data.tx);
      }

      throw error;
    });
};

export class HyperliquidVmAttestor extends VmAttestor {
  public async getDepositoryDepositMessages(
    chainId: string,
    transactionId: string,
  ): Promise<EnhancedDepositoryDepositMessage[]> {
    const trackingId = getTrackingId();

    const rpc = await httpRpc(chainId);

    // Get transaction details
    const txDetails = await getTxDetailsWithFallback(
      chainId,
      transactionId,
      trackingId,
    );
    if (!txDetails) {
      throw externalError(
        `Missing transaction ${transactionId} on chain ${chainId}`,
      );
    }
    if (txDetails.error) {
      throw externalError(`Transaction failed: ${transactionId}`);
    }

    const chain = await getChain(chainId);
    const depository = chain.depository;
    if (!depository) {
      throw externalError("Chain has no depository configured");
    }

    const messages: EnhancedDepositoryDepositMessage[] = [];
    const timestamp = Math.floor(txDetails.time / 1000).toString();

    switch (txDetails.action.type) {
      case "usdSend": {
        const action = txDetails.action as unknown as hl.UsdSendParameters & {
          time: number;
        };

        // Check if this is a deposit to the depository
        if (action.destination.toLowerCase() === depository.toLowerCase()) {
          const depositor = txDetails.user.toLowerCase();
          const depositId = await this._lookupId(
            chainId,
            depositor,
            Number(action.time),
            Number(txDetails.time),
          );

          messages.push({
            data: {
              chainId,
              transactionId,
            },
            result: {
              onchainId: getDeterministicId(chainId, transactionId, "0"),
              depository,
              depositId: depositId ?? zeroHash,
              depositor,
              currency: getVmTypeNativeCurrency(VM_TYPE),
              amount: parseUnits(
                Number(action.amount).toFixed(8),
                8,
              ).toString(),
            },
            extraData: {
              timestamp,
            },
          });
        }

        break;
      }

      case "sendAsset": {
        const action = txDetails.action as unknown as hl.SendAssetParameters & {
          nonce: number;
        };

        // Check if this is a deposit to the depository
        if (action.destination.toLowerCase() === depository.toLowerCase()) {
          const depositor = txDetails.user.toLowerCase();
          const tokenAddress = action.token.split(":")[1];
          const tokenDex = action.destinationDex;
          if (tokenDex === "" && tokenAddress !== SPOT_USDC) {
            throw externalError("Only USDC is supported as a Perps token");
          }

          const currency =
            tokenDex === "spot"
              ? tokenAddress.toLowerCase()
              : tokenDex === ""
                ? getVmTypeNativeCurrency(VM_TYPE)
                : tokenAddress.toLowerCase() +
                  Buffer.from(tokenDex, "ascii").toString("hex");

          const currencyDecimals =
            currency === getVmTypeNativeCurrency(VM_TYPE)
              ? 8
              : await (async () => {
                  await logRpcUsage(chainId, "spotMeta", trackingId);
                  return rpc
                    .spotMeta()
                    .then(
                      (r) =>
                        r.tokens.find((t) => t.tokenId === tokenAddress)
                          ?.szDecimals,
                    );
                })();
          if (currencyDecimals === undefined) {
            throw externalError("Could not retrieve payment currency decimals");
          }

          const depositId = await this._lookupId(
            chainId,
            depositor,
            Number(action.nonce),
            Number(txDetails.time),
          );

          messages.push({
            data: {
              chainId,
              transactionId,
            },
            result: {
              onchainId: getDeterministicId(chainId, transactionId, "0"),
              depository,
              depositId: depositId ?? zeroHash,
              depositor,
              currency,
              amount: parseUnits(
                Number(action.amount).toFixed(currencyDecimals),
                currencyDecimals,
              ).toString(),
            },
            extraData: {
              timestamp,
            },
          });
        }
        break;
      }

      default:
        // For other transaction types, return empty array
        break;
    }

    return messages;
  }

  public async getDepositoryWithdrawalMessage(
    chainId: string,
    withdrawal: string,
    transactionId?: string,
  ): Promise<DepositoryWithdrawalMessage> {
    const trackingId = getTrackingId();

    const chain = await getChain(chainId);

    const depository = chain.depository;
    if (!depository) {
      throw externalError("Chain has no depository configured");
    }

    const decodedWithdrawal = decodeWithdrawal(
      withdrawal,
      chain.vmType,
    ) as DecodedHyperliquidVmWithdrawal;
    const withdrawalId = getDecodedWithdrawalId(decodedWithdrawal);

    let status: DepositoryWithdrawalStatus = DepositoryWithdrawalStatus.PENDING;

    // Get recent transactions for checking both execution and expiry
    const rpc = await httpRpc(chainId);
    await logRpcUsage(chainId, "userDetails", trackingId);
    const userDetails = await rpc.userDetails({
      user: depository as any,
    });

    // First check if the withdrawal exists in recent transactions
    const recentTxs = userDetails.txs;
    for (const tx of recentTxs) {
      if (tx.user.toLowerCase() === depository.toLowerCase()) {
        const txMessageHash = this._getMessageHash(tx.action);
        if (txMessageHash && withdrawalId === txMessageHash) {
          if (!tx.error) {
            status = DepositoryWithdrawalStatus.EXECUTED;
          } else {
            status = DepositoryWithdrawalStatus.EXPIRED;
          }
          break;
        }
      }
    }

    // If the withdrawal was not found in recent transactions but `transactionId` is provided, check that specific transaction
    if (status === DepositoryWithdrawalStatus.PENDING && transactionId) {
      const txDetails = await getTxDetailsWithFallback(
        chainId,
        transactionId,
        trackingId,
      );
      if (!txDetails) {
        throw externalError(
          `Missing transaction ${transactionId} on chain ${chainId}`,
        );
      }

      // Verify transaction is from depository
      if (txDetails.user.toLowerCase() === depository.toLowerCase()) {
        // Verify the transaction's message hash matches the withdrawal id
        const txMessageHash = this._getMessageHash(txDetails.action);
        if (txMessageHash && withdrawalId === txMessageHash) {
          if (!txDetails.error) {
            status = DepositoryWithdrawalStatus.EXECUTED;
          } else {
            status = DepositoryWithdrawalStatus.EXPIRED;
          }
        }
      }
    }

    // Check if the withdrawal can be considered expired
    if (status === DepositoryWithdrawalStatus.PENDING) {
      const { parameters } = decodedWithdrawal.withdrawal;

      const withdrawalNonce =
        parameters.type === "SendAsset"
          ? Number(parameters.nonce)
          : Number(parameters.time);

      // The nonce will not be accepted if it's older than 2 days
      // https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets#hyperliquid-nonces
      if (withdrawalNonce < Date.now() - 2 * 24 * 3600 * 1000) {
        status = DepositoryWithdrawalStatus.EXPIRED;
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
    hints?: TxHints,
  ): Promise<bigint> {
    const trackingId = getTrackingId();

    const rpc = await httpRpc(chainId);

    // Ensure the transaction was successfully included
    const txDetails = await getTxDetailsWithFallback(
      chainId,
      transactionId,
      trackingId,
      hints,
    );
    if (!txDetails || txDetails.error) {
      throw externalError(`Missing or reverted transaction ${transactionId}`);
    }

    const transactionTimestamp = Math.floor(txDetails.time / 1000);
    if (transactionTimestamp > payment.deadline) {
      throw externalError(
        `Transaction ${transactionId} executed after deadline`,
      );
    }

    if (payment.currency === getVmTypeNativeCurrency(VM_TYPE)) {
      if (txDetails.action.type === "sendAsset") {
        const txParameters =
          txDetails.action as unknown as hl.SendAssetParameters;
        const [tokenSymbol, tokenAddress] = txParameters.token.split(":");
        const tokenDex = txParameters.destinationDex;

        // Native currency is USDC on perps (destinationDex === "")
        if (
          tokenSymbol === "USDC" &&
          tokenAddress === SPOT_USDC &&
          tokenDex === "" &&
          txParameters.destination.toLowerCase() ===
            payment.recipient.toLowerCase()
        ) {
          return parseUnits(Number(txParameters.amount).toFixed(8), 8);
        }
      } else if (txDetails.action.type === "usdSend") {
        const txParameters =
          txDetails.action as unknown as hl.UsdSendParameters;
        if (
          txParameters.destination.toLowerCase() ===
          payment.recipient.toLowerCase()
        ) {
          return parseUnits(Number(txParameters.amount).toFixed(8), 8);
        }
      }

      throw externalError("Could not detect payment");
    } else {
      if (txDetails.action.type === "sendAsset") {
        const txParameters =
          txDetails.action as unknown as hl.SendAssetParameters;

        const [orderPaymentCurrency, orderPaymentDex] = [
          payment.currency.slice(0, 34),
          payment.currency.slice(34) === ""
            ? "spot"
            : Buffer.from(payment.currency.slice(34), "hex").toString("ascii"),
        ];
        const [actualPaymentCurrency, actualPaymentDex] = [
          txParameters.token.split(":")[1],
          txParameters.destinationDex,
        ];

        if (
          txParameters.destination.toLowerCase() ===
            payment.recipient.toLowerCase() &&
          orderPaymentCurrency.toLowerCase() ===
            actualPaymentCurrency.toLowerCase() &&
          orderPaymentDex === actualPaymentDex
        ) {
          await logRpcUsage(chainId, "spotMeta", trackingId);
          const currencyDecimals = await rpc
            .spotMeta()
            .then(
              (r) =>
                r.tokens.find((t) => t.tokenId === actualPaymentCurrency)
                  ?.szDecimals,
            );
          if (currencyDecimals === undefined) {
            throw externalError("Could not retrieve payment currency decimals");
          }

          return parseUnits(
            Number(txParameters.amount).toFixed(currencyDecimals),
            currencyDecimals,
          );
        }
      }

      throw externalError("Could not detect payment");
    }
  }

  public async verifySolverCalls(
    _chainId: string,
    _transactionId: string,
    _calls: string[],
  ): Promise<boolean> {
    throw internalError("Not implemented (verifySolverCalls)");
  }

  private async _lookupId(
    chainId: string,
    depositor: string,
    nonce: number,
    timestamp: number,
  ): Promise<string | undefined> {
    const chain = await getChain(chainId);

    const hubApiUrl = chain.additionalData?.hubApiUrl;
    if (!hubApiUrl) {
      throw externalError("Chain has no hub API URL configured");
    }

    const data = await axios
      .get(
        `${hubApiUrl}/queries/nonce-mappings/${chainId}/${depositor}/${nonce}/v1`,
        {
          headers: {
            "x-api-key": process.env.HUB_API_KEY,
          },
          timeout: 10000,
        },
      )
      .then(
        (response) =>
          response.data as { id: string; createdAt: string } | undefined,
      );

    const THRESHOLD = 3600 * 1000;
    if (data) {
      // If we have a nonce-mapping available, make sure it was created within the time threshold
      if (new Date(data.createdAt).getTime() > timestamp + THRESHOLD) {
        return undefined;
      } else {
        return data.id;
      }
    } else {
      // If we don't have any nonce-mapping available, don't attest anything unless we're sure none can ever get associated
      if (Date.now() > timestamp + THRESHOLD) {
        return undefined;
      } else {
        throw externalError(
          `No nonce mapping found for nonce ${nonce} and depositor ${depositor}`,
        );
      }
    }
  }

  private _getMessageHash(action: any): string | undefined {
    switch (action.type) {
      case "usdSend": {
        return hashStruct({
          types: {
            "HyperliquidTransaction:UsdSend": [
              { name: "hyperliquidChain", type: "string" },
              { name: "destination", type: "string" },
              { name: "amount", type: "string" },
              { name: "time", type: "uint64" },
            ],
          },
          primaryType: "HyperliquidTransaction:UsdSend",
          data: {
            hyperliquidChain: action.hyperliquidChain,
            destination: action.destination,
            amount: action.amount,
            time: action.time,
          },
        });
      }

      case "sendAsset": {
        return hashStruct({
          types: {
            "HyperliquidTransaction:SendAsset": [
              { name: "hyperliquidChain", type: "string" },
              { name: "destination", type: "string" },
              { name: "sourceDex", type: "string" },
              { name: "destinationDex", type: "string" },
              { name: "token", type: "string" },
              { name: "amount", type: "string" },
              { name: "fromSubAccount", type: "string" },
              { name: "nonce", type: "uint64" },
            ],
          },
          primaryType: "HyperliquidTransaction:SendAsset",
          data: {
            hyperliquidChain: action.hyperliquidChain,
            destination: action.destination,
            sourceDex: action.sourceDex,
            destinationDex: action.destinationDex,
            token: action.token,
            amount: action.amount,
            fromSubAccount: action.fromSubAccount,
            nonce: action.nonce,
          },
        });
      }

      default: {
        return undefined;
      }
    }
  }
}

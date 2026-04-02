import {
  DecodedEthereumVmWithdrawal,
  decodeOrderCall,
  decodeOrderExtraData,
  decodeWithdrawal,
  DepositoryWithdrawalMessage,
  DepositoryWithdrawalStatus,
  getDecodedWithdrawalId,
  getVmTypeNativeCurrency,
} from "@relay-protocol/settlement-sdk";
import {
  Address,
  getContract,
  Hex,
  hexToBigInt,
  parseAbi,
  parseEventLogs,
  TransactionReceipt,
  zeroHash,
} from "viem";

import { getDeterministicId } from "../../utils";
import { EnhancedDepositoryDepositMessage, VmAttestor } from "../../vm/types";
import { getChain } from "../../../../common/chains";
import { externalError } from "../../../../common/error";
import { getTrackingId, logRpcUsage } from "../../../../common/rpc-usage";
import { httpRpc } from "../../../../common/vm/ethereum-vm/rpc";

export const ABI = parseAbi([
  "event RelayNativeDeposit(address from, uint256 amount, bytes32 id)",
  "event RelayErc20Deposit(address from, address token, uint256 amount, bytes32 id)",
  "event SolverNativeTransfer(address to, uint256 amount)",
  "event SolverCallExecuted(address to, bytes data, uint256 amount)",
  "event Transfer(address indexed from, address indexed to, uint256 amount)",
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function callRequests(bytes32 withdrawalId) view returns (bool)",
]);

const VM_TYPE = "ethereum-vm";

const ZKSYNC_ERC20_ETH = "0x000000000000000000000000000000000000800a";

export class EthereumVmAttestor extends VmAttestor {
  public async getDepositoryDepositMessages(
    chainId: string,
    transactionId: string,
  ): Promise<EnhancedDepositoryDepositMessage[]> {
    const trackingId = getTrackingId();

    const rpc = await httpRpc(chainId);

    // Ensure the transaction was successfully included
    await logRpcUsage(chainId, "eth_getTransactionReceipt", trackingId);
    const receipt = await rpc
      .getTransactionReceipt({
        hash: transactionId as Hex,
      })
      .catch((error) => {
        if ((error as any).name === "TransactionReceiptNotFoundError") {
          throw externalError(
            `Missing transaction ${transactionId} on chain ${chainId}`,
          );
        }

        throw error;
      });
    if (receipt.status !== "success") {
      throw externalError(
        `Reverted transaction ${transactionId} on chain ${chainId}`,
      );
    }

    // Ensure the transaction is finalized
    const timestamp = await this._ensureTxFinalization(
      chainId,
      receipt,
      trackingId,
    );

    const chain = await getChain(chainId);

    const depository = chain.depository;
    if (!depository) {
      throw externalError("Chain has no depository configured");
    }

    // Parse and filter the logs we're interested in
    const parsedLogs = parseEventLogs({
      abi: ABI,
      logs: receipt.logs,
      eventName: ["RelayNativeDeposit", "RelayErc20Deposit", "Transfer"],
    }).filter((log) => {
      if (
        log.eventName === "RelayNativeDeposit" &&
        log.address.toLowerCase() === depository.toLowerCase()
      ) {
        return true;
      }

      if (
        log.eventName === "RelayErc20Deposit" &&
        log.address.toLowerCase() === depository.toLowerCase()
      ) {
        return true;
      }

      if (
        log.eventName === "Transfer" &&
        log.args.to.toLowerCase() === depository.toLowerCase()
      ) {
        return true;
      }

      return false;
    });

    // Sort the logs accordigng to their onchain order
    parsedLogs.sort((l1, l2) => l1.logIndex - l2.logIndex);

    const messages: EnhancedDepositoryDepositMessage[] = [];
    for (let i = 0; i < parsedLogs.length; i++) {
      const currentLog = parsedLogs[i];
      const nextLogIndex = i + 1;

      if (currentLog?.eventName === "RelayNativeDeposit") {
        const depositId = currentLog.args.id.toLowerCase();

        messages.push({
          data: {
            chainId,
            transactionId,
          },
          result: {
            onchainId: getDeterministicId(
              chainId,
              transactionId,
              currentLog.logIndex.toString(),
            ),
            depository,
            depositId,
            depositor: currentLog.args.from.toLowerCase(),
            currency: getVmTypeNativeCurrency(VM_TYPE),
            amount: currentLog.args.amount.toString(),
          },
          extraData: {
            timestamp: String(timestamp),
          },
        });
      }

      if (currentLog?.eventName === "Transfer") {
        let depositor = currentLog.args.from.toLowerCase();

        // If any of the next events in the transaction is a matching `Erc20Deposit` event, take the id and depositor from there
        let depositId: string | undefined;
        for (let j = nextLogIndex; j < parsedLogs.length; j++) {
          const nextLog = parsedLogs[j];

          // Stop as soon as we encounter a different `Transfer` event
          if (nextLog.eventName === "Transfer") {
            break;
          }

          if (
            nextLog.eventName === "RelayErc20Deposit" &&
            nextLog.args.token.toLowerCase() ===
              currentLog.address.toLowerCase() &&
            nextLog.args.amount === currentLog.args.amount
          ) {
            depositor = nextLog.args.from.toLowerCase();

            if (nextLog.args.id !== zeroHash) {
              depositId = nextLog.args.id;
            }
          }
        }

        // If the transaction involves a single `Transfer` event and the calldata matches a standard ERC20 transfer,
        // take the deposit id from the end of the transfer calldata (if the end of calldata has at least 32 bytes)
        if (
          !depositId &&
          parsedLogs.filter(
            (l) =>
              l.eventName === "Transfer" &&
              l.args.to.toLowerCase() === depository.toLowerCase(),
          ).length === 1
        ) {
          // We know we have a single depository transfer event
          const uniqueDepositoryTransferEvent = parsedLogs.find(
            (l) =>
              l.eventName === "Transfer" &&
              l.args.to.toLowerCase() === depository.toLowerCase(),
          )!;

          // Find all standard transfers within the transaction calldata
          const findTransfersInCalldata = (calldata: string) => {
            const regex =
              /(a9059cbb)([0-9a-fA-F]{64})([0-9a-fA-F]{64})([0-9a-fA-F]{64})?|(23b872dd)([0-9a-fA-F]{64})([0-9a-fA-F]{64})([0-9a-fA-F]{64})([0-9a-fA-F]{64})?/g;

            const results: { to: string; amount: string; id?: string }[] = [];

            let match: RegExpExecArray | null;
            while ((match = regex.exec(calldata)) !== null) {
              if (match[1]) {
                results.push({
                  to: `0x${match[2].slice(24)}`.toLowerCase(),
                  amount: hexToBigInt(`0x${match[3]}`).toString(),
                  id: match[4] ? `0x${match[4]}`.toLowerCase() : undefined,
                });
              } else {
                results.push({
                  to: `0x${match[7].slice(24)}`.toLowerCase(),
                  amount: hexToBigInt(`0x${match[8]}`).toString(),
                  id: match[9] ? `0x${match[9]}`.toLowerCase() : undefined,
                });
              }
            }

            return results;
          };

          await logRpcUsage(chainId, "eth_getTransaction", trackingId);
          const transactionCalldata = (
            await this._getTransaction(chainId, transactionId)
          ).input;

          // Find all standard transfers matching the transfer event
          const transfersToDepository = findTransfersInCalldata(
            transactionCalldata,
          ).filter(
            (t) =>
              t.to.toLowerCase() === depository.toLowerCase() &&
              t.amount === uniqueDepositoryTransferEvent.args.amount.toString(),
          );
          // We allow either a single matching transfer calldata or multiple ones that are all the same
          if (
            transfersToDepository.length === 1 ||
            (transfersToDepository.length > 1 &&
              transfersToDepository.every(
                (t) =>
                  t.to === transfersToDepository[0].to &&
                  t.amount === transfersToDepository[0].amount &&
                  t.id === transfersToDepository[0].id,
              ))
          ) {
            // If the id starts with a zero prefix it means it was not intended
            // to be a deposit id, but rather unrelated trailing calldata
            if (
              transfersToDepository[0].id &&
              !transfersToDepository[0].id.startsWith(zeroHash.slice(0, 34))
            ) {
              depositId = transfersToDepository[0].id;
            }
          }
        }

        const currency = currentLog.address.toLowerCase();
        if (
          chain.additionalData?.isZksyncStack &&
          currency === ZKSYNC_ERC20_ETH
        ) {
          continue;
        }

        messages.push({
          data: {
            chainId,
            transactionId,
          },
          result: {
            onchainId: getDeterministicId(
              chainId,
              transactionId,
              currentLog.logIndex.toString(),
            ),
            depository,
            depositId: depositId ?? zeroHash,
            depositor,
            currency,
            amount: currentLog.args.amount.toString(),
          },
          extraData: {
            timestamp: String(timestamp),
          },
        });
      }
    }

    return messages;
  }

  public async getDepositoryWithdrawalMessage(
    chainId: string,
    withdrawal: string,
  ): Promise<DepositoryWithdrawalMessage> {
    const trackingId = getTrackingId();

    const rpc = await httpRpc(chainId);
    const chain = await getChain(chainId);

    const depository = chain.depository;
    if (!depository) {
      throw externalError("Chain has no depository configured");
    }

    const decodedWithdrawal = decodeWithdrawal(
      withdrawal,
      chain.vmType,
    ) as DecodedEthereumVmWithdrawal;
    const withdrawalId = getDecodedWithdrawalId(decodedWithdrawal);

    const depositoryContract = getContract({
      address: chain.depository as Address,
      abi: ABI,
      client: rpc,
    });
    const finalizationBlocks = await this._getFinalizationBlocks(chainId);
    const finalizationTime = await this._getFinalizationTime(chainId);

    await logRpcUsage(chainId, "eth_getBlock", trackingId);
    const latestBlock = await rpc.getBlock();
    const finalizedBlockNumber =
      BigInt(latestBlock.number!) - BigInt(finalizationBlocks);

    await logRpcUsage(chainId, "eth_call", trackingId);
    const isExecuted = await depositoryContract.read.callRequests(
      [withdrawalId as Hex],
      { blockNumber: finalizedBlockNumber },
    );

    let status: DepositoryWithdrawalStatus;
    if (isExecuted) {
      status = DepositoryWithdrawalStatus.EXECUTED;
    } else {
      await logRpcUsage(chainId, "eth_getBlock", trackingId);
      const finalizedTimestamp = await rpc
        .getBlock({ blockNumber: finalizedBlockNumber })
        .then((b) => b.timestamp);

      const expiration = BigInt(decodedWithdrawal.withdrawal.expiration);
      if (
        BigInt(finalizedTimestamp) > expiration &&
        BigInt(latestBlock.timestamp) - BigInt(finalizationTime) > expiration
      ) {
        status = DepositoryWithdrawalStatus.EXPIRED;
      } else {
        status = DepositoryWithdrawalStatus.PENDING;
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

    const rpc = await httpRpc(chainId);

    // Ensure the transaction was successfully included
    await logRpcUsage(chainId, "eth_getTransactionReceipt", trackingId);
    const receipt = await rpc
      .getTransactionReceipt({
        hash: transactionId as Hex,
      })
      .catch((error) => {
        if ((error as any).name === "TransactionReceiptNotFoundError") {
          throw externalError(
            `Missing transaction ${transactionId} on chain ${chainId}`,
          );
        }

        throw error;
      });
    if (receipt.status !== "success") {
      throw externalError(
        `Reverted transaction ${transactionId} on chain ${chainId}`,
      );
    }

    // Ensure the transaction is finalized
    const timestamp = await this._ensureTxFinalization(
      chainId,
      receipt,
      trackingId,
    );

    if (timestamp > payment.deadline) {
      throw externalError(
        `Transaction ${transactionId} executed after deadline`,
      );
    }

    await logRpcUsage(chainId, "eth_getTransaction", trackingId);
    const transaction = await this._getTransaction(chainId, transactionId);
    if (!transaction) {
      throw externalError(`Missing transaction ${transactionId}`);
    }

    if (!transaction.input.endsWith(payment.orderId.slice(2))) {
      throw externalError(
        `Transaction ${transactionId} does not reference order id`,
      );
    }

    if (payment.currency === getVmTypeNativeCurrency(VM_TYPE)) {
      // If the payment involves native currency, we first try to see if this is a direct transfer
      if (
        transaction.to?.toLowerCase() === payment.recipient.toLowerCase() &&
        transaction.input.startsWith(payment.orderId)
      ) {
        return transaction.value;
      }

      // Otherwise, check for any native transfer events emitted via the fill contract specified by the order
      const fillContract = decodeOrderExtraData(payment.extraData, VM_TYPE)
        .extraData.fillContract;
      return parseEventLogs({
        abi: ABI,
        logs: receipt.logs,
        eventName: ["SolverNativeTransfer"],
      })
        .filter(
          (log) =>
            log.address.toLowerCase() === fillContract.toLowerCase() &&
            log.args.to.toLowerCase() === payment.recipient.toLowerCase(),
        )
        .map((log) => log.args.amount)
        .reduce((a, b) => a + b, 0n);
    } else {
      // If the payment involves ERC20 currencies, work off standard transfer events
      return parseEventLogs({
        abi: ABI,
        logs: receipt.logs,
        eventName: ["Transfer"],
      })
        .filter(
          (log) =>
            log.address.toLowerCase() === payment.currency.toLowerCase() &&
            log.args.to.toLowerCase() === payment.recipient.toLowerCase(),
        )
        .map((log) => log.args.amount)
        .reduce((a, b) => a + b, 0n);
    }
  }

  public async verifySolverCalls(
    chainId: string,
    transactionId: string,
    calls: string[],
    extraData: string,
  ): Promise<boolean> {
    const trackingId = getTrackingId();

    const rpc = await httpRpc(chainId);
    const chain = await getChain(chainId);

    // Ensure the transaction was successfully included
    await logRpcUsage(chainId, "eth_getTransactionReceipt", trackingId);
    const receipt = await rpc
      .getTransactionReceipt({
        hash: transactionId as Hex,
      })
      .catch((error) => {
        if ((error as any).name === "TransactionReceiptNotFoundError") {
          throw externalError(
            `Missing transaction ${transactionId} on chain ${chainId}`,
          );
        }

        throw error;
      });
    if (receipt.status !== "success") {
      throw externalError(
        `Reverted transaction ${transactionId} on chain ${chainId}`,
      );
    }

    // Ensure the transaction is finalized
    await this._ensureTxFinalization(chainId, receipt, trackingId);

    const fillContract = decodeOrderExtraData(extraData, VM_TYPE).extraData
      .fillContract;

    // Parse and filter the logs we're interested in
    const parsedLogs = parseEventLogs({
      abi: ABI,
      logs: receipt.logs,
      eventName: ["SolverCallExecuted"],
    }).filter((log) => {
      if (
        log.eventName === "SolverCallExecuted" &&
        log.address.toLowerCase() === fillContract.toLowerCase()
      ) {
        return true;
      }

      return false;
    });
    parsedLogs.sort((l1, l2) => l1.logIndex - l2.logIndex);

    let logSearchStartIndex = 0;
    for (const call of calls) {
      const decodedCall = decodeOrderCall(call, chain.vmType);

      const relevantLogIndex = parsedLogs.findIndex(
        (log, i) =>
          i >= logSearchStartIndex &&
          log.args.to.toLowerCase() === decodedCall.call.to.toLowerCase() &&
          log.args.data.toLowerCase() === decodedCall.call.data.toLowerCase() &&
          log.args.amount === BigInt(decodedCall.call.value),
      );
      if (relevantLogIndex === -1) {
        return false;
      }

      logSearchStartIndex = relevantLogIndex + 1;
    }

    return true;
  }

  private _DEFAULT_FINALIZATION_BLOCKS = 10;
  private _DEFAULT_FINALIZATION_TIME = 60;

  private async _getFinalizationBlocks(chainId: string): Promise<number> {
    const chain = await getChain(chainId);
    return (
      chain.additionalData?.finalizationBlocks ??
      this._DEFAULT_FINALIZATION_BLOCKS
    );
  }

  private async _getFinalizationTime(chainId: string): Promise<number> {
    const chain = await getChain(chainId);
    return (
      chain.additionalData?.finalizationTime ?? this._DEFAULT_FINALIZATION_TIME
    );
  }

  private async _ensureTxFinalization(
    chainId: string,
    tx: TransactionReceipt,
    trackingId: string,
  ) {
    const rpc = await httpRpc(chainId);

    const finalizationBlocks = await this._getFinalizationBlocks(chainId);
    const finalizationTime = await this._getFinalizationTime(chainId);

    await logRpcUsage(chainId, "eth_getBlock", trackingId);
    const latestBlock = await rpc.getBlock();
    if (
      BigInt(latestBlock.number!) - BigInt(tx.blockNumber) <
      BigInt(finalizationBlocks)
    ) {
      throw externalError(`Transaction ${tx.transactionHash} is not finalized`);
    }

    await logRpcUsage(chainId, "eth_getBlock", trackingId);
    const txTimestamp = await rpc
      .getBlock({ blockNumber: tx.blockNumber })
      .then((b) => b.timestamp);
    if (
      BigInt(latestBlock.timestamp) - BigInt(txTimestamp) <
      BigInt(finalizationTime)
    ) {
      throw externalError(`Transaction ${tx.transactionHash} is not finalized`);
    }

    return txTimestamp;
  }

  private async _getTransaction(chainId: string, transactionId: string) {
    const rpc = await httpRpc(chainId);

    const tx = await rpc.getTransaction({ hash: transactionId as Hex });
    if (chainId === "tempo" && !tx.input) {
      tx.input = (tx as any as { calls: { input: string }[] }).calls[0]
        .input as Hex;
    }

    return tx;
  }
}

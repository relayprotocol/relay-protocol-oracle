import {
  DecodedEthereumVmWithdrawal,
  decodeOrderCall,
  decodeOrderExtraData,
  decodeWithdrawal,
  DepositoryDepositMessage,
  DepositoryWithdrawalMessage,
  DepositoryWithdrawalStatus,
  getDecodedWithdrawalId,
  VmType,
} from "@reservoir0x/relay-protocol-sdk";

import {
  Address,
  decodeFunctionData,
  getContract,
  Hex,
  parseAbi,
  parseEventLogs,
  TransactionReceipt,
  zeroAddress,
  zeroHash,
} from "viem";

import { getDeterministicId } from "../utils";
import { getChain } from "../../../../common/chains";
import { externalError } from "../../../../common/error";
import { undefinedOnThrow } from "../../../../common/utils";
import { httpRpc } from "../../../../common/vm/ethereum-vm/rpc";
import { VmAttestor } from "../../vm/types";

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

const VM_TYPE: VmType = "ethereum-vm";

export class EthereumVmAttestor extends VmAttestor {
  public async getDepositoryDepositMessages(
    chainId: string,
    transactionId: string
  ): Promise<DepositoryDepositMessage[]> {
    const rpc = await httpRpc(chainId);

    // Ensure the transaction was successfully included
    const receipt = await rpc
      .getTransactionReceipt({
        hash: transactionId as Hex,
      })
      .catch((error) => {
        if ((error as any).name === "TransactionReceiptNotFoundError") {
          throw externalError(
            `Missing transaction ${transactionId} on chain ${chainId}`
          );
        }

        throw error;
      });
    if (receipt.status !== "success") {
      throw externalError(
        `Reverted transaction ${transactionId} on chain ${chainId}`
      );
    }

    // Ensure the transaction is finalized
    await this._ensureTxFinalization(chainId, receipt);

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

    const messages: DepositoryDepositMessage[] = [];
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
              currentLog.logIndex.toString()
            ),
            depository,
            depositId,
            depositor: currentLog.args.from.toLowerCase(),
            currency: zeroAddress,
            amount: currentLog.args.amount.toString(),
          },
        });
      }

      if (currentLog?.eventName === "Transfer") {
        let depositor = currentLog.args.from.toLowerCase();

        // If any of the next events in the transaction is a matching `Erc20Deposit` event, take the id and depositor from there
        let depositId: string | undefined;
        for (let j = nextLogIndex; j < parsedLogs.length; j++) {
          const nextLog = parsedLogs[j];
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
        // take the deposit id from the end of calldata (if the end of calldata has at least 32 bytes)
        if (
          !depositId &&
          parsedLogs.filter((l) => l.eventName === "Transfer").length === 1
        ) {
          const transactionCalldata = (
            await rpc.getTransaction({ hash: transactionId as Hex })
          ).input;
          const decodedFunctionData = await undefinedOnThrow(() =>
            decodeFunctionData({
              abi: ABI,
              data: transactionCalldata,
            })
          );
          if (decodedFunctionData) {
            const endOfCalldata = transactionCalldata.slice(
              // The `0x` prefix
              2 +
                // The 4byte method signature
                8 +
                // Either 64 or 96 bytes depending on the called method
                64 * (decodedFunctionData.functionName === "transfer" ? 2 : 3)
            );
            if (endOfCalldata.length >= 64) {
              // We take the first 32 bytes from the end of calldata
              const parsedId = "0x" + endOfCalldata.slice(0, 64);
              if (parsedId !== zeroHash) {
                depositId = parsedId;
              }
            }
          }
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
              currentLog.logIndex.toString()
            ),
            depository,
            depositId: depositId ?? zeroHash,
            depositor,
            currency: currentLog.address.toLowerCase(),
            amount: currentLog.args.amount.toString(),
          },
        });
      }
    }

    return messages;
  }

  public async getDepositoryWithdrawalMessage(
    chainId: string,
    withdrawal: string
  ): Promise<DepositoryWithdrawalMessage> {
    const rpc = await httpRpc(chainId);
    const chain = await getChain(chainId);

    const depository = chain.depository;
    if (!depository) {
      throw externalError("Chain has no depository configured");
    }

    const decodedWithdrawal = decodeWithdrawal(
      withdrawal,
      chain.vmType
    ) as DecodedEthereumVmWithdrawal;
    const withdrawalId = getDecodedWithdrawalId(decodedWithdrawal);

    const depositoryContract = getContract({
      address: chain.depository as Address,
      abi: ABI,
      client: rpc,
    });
    const isExecuted = await depositoryContract.read.callRequests([
      withdrawalId as Hex,
    ]);

    let status: DepositoryWithdrawalStatus;
    if (isExecuted) {
      status = DepositoryWithdrawalStatus.EXECUTED;
    } else {
      const chainTimestamp = await rpc
        .getBlock()
        .then((block) => block.timestamp);
      if (
        chainTimestamp - this._FINALIZATION_TIME >
        BigInt(decodedWithdrawal.withdrawal.expiration)
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
      orderHash: string;
      extraData: string;
      deadline: number;
    }
  ): Promise<bigint> {
    const rpc = await httpRpc(chainId);

    // Ensure the transaction was successfully included
    const receipt = await rpc
      .getTransactionReceipt({
        hash: transactionId as Hex,
      })
      .catch((error) => {
        if ((error as any).name === "TransactionReceiptNotFoundError") {
          throw externalError(
            `Missing transaction ${transactionId} on chain ${chainId}`
          );
        }

        throw error;
      });
    if (receipt.status !== "success") {
      throw externalError(
        `Reverted transaction ${transactionId} on chain ${chainId}`
      );
    }

    // Ensure the transaction is finalized
    await this._ensureTxFinalization(chainId, receipt);

    const transactionTimestamp = await rpc
      .getBlock({ blockNumber: receipt.blockNumber })
      .then((block) => block.timestamp);
    if (transactionTimestamp > payment.deadline) {
      throw externalError(
        `Transaction ${transactionId} executed after deadline`
      );
    }

    const transaction = await rpc.getTransaction({
      hash: transactionId as Hex,
    });
    if (!transaction) {
      throw externalError(`Missing transaction ${transactionId}`);
    }

    if (!transaction.input.endsWith(payment.orderHash.slice(2))) {
      throw externalError(
        `Transaction ${transactionId} does not reference order hash`
      );
    }

    if (payment.currency === zeroAddress) {
      // If the payment involves native currency, we first try to see if this is a direct transfer
      if (
        transaction.to?.toLowerCase() === payment.recipient.toLowerCase() &&
        transaction.input.startsWith(payment.orderHash)
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
            log.args.to.toLowerCase() === payment.recipient.toLowerCase()
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
            log.args.to.toLowerCase() === payment.recipient.toLowerCase()
        )
        .map((log) => log.args.amount)
        .reduce((a, b) => a + b, 0n);
    }
  }

  public async verifySolverCalls(
    chainId: string,
    transactionId: string,
    calls: string[],
    extraData: string
  ): Promise<boolean> {
    const rpc = await httpRpc(chainId);
    const chain = await getChain(chainId);

    // Ensure the transaction was successfully included
    const receipt = await rpc
      .getTransactionReceipt({
        hash: transactionId as Hex,
      })
      .catch((error) => {
        if ((error as any).name === "TransactionReceiptNotFoundError") {
          throw externalError(
            `Missing transaction ${transactionId} on chain ${chainId}`
          );
        }

        throw error;
      });
    if (receipt.status !== "success") {
      throw externalError(
        `Reverted transaction ${transactionId} on chain ${chainId}`
      );
    }

    // Ensure the transaction is finalized
    await this._ensureTxFinalization(chainId, receipt);

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

    const usedParsedLogIndexes = new Set<number>();
    for (const call of calls) {
      const decodedCall = decodeOrderCall(call, chain.vmType);

      const relevantLogIndex = parsedLogs.findIndex(
        (log, i) =>
          log.args.to.toLowerCase() === decodedCall.call.to.toLowerCase() &&
          log.args.data.toLowerCase() === decodedCall.call.data.toLowerCase() &&
          log.args.amount === BigInt(decodedCall.call.value) &&
          !usedParsedLogIndexes.has(i)
      );
      if (relevantLogIndex === -1) {
        return false;
      } else {
        usedParsedLogIndexes.add(relevantLogIndex);
      }
    }

    return true;
  }

  private _FINALIZATION_TIME = 60n;

  private async _ensureTxFinalization(chainId: string, tx: TransactionReceipt) {
    const rpc = await httpRpc(chainId);

    const latestBlockTimestamp = await rpc.getBlock().then((b) => b.timestamp);
    const txTimestamp = await rpc
      .getBlock({ blockNumber: tx.blockNumber })
      .then((b) => b.timestamp);
    if (latestBlockTimestamp - txTimestamp < this._FINALIZATION_TIME) {
      throw externalError(`Transaction ${tx.transactionHash} is not finalized`);
    }
  }
}

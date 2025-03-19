import {
  decodeFunctionData,
  Log,
  parseAbi,
  parseEventLogs,
  Transaction,
  TransactionReceipt,
  zeroAddress,
  zeroHash,
} from "viem";

import { getChain } from "../../../../common/chains";
import { Lazy, undefinedOnThrow } from "../../../../common/utils";
import * as jobs from "../../../../jobs";
import { TransactionEntry } from "../../../../models/transactions";

// Define the events to listen to
export const ABI = parseAbi([
  "event NativeDeposit(address from, uint256 amount, bytes32 id)",
  "event Erc20Deposit(address from, address token, uint256 amount, bytes32 id)",
  "event Transfer(address indexed from, address indexed to, uint256 amount)",
  "event CallExecuted(bytes32 id, (address to, bytes data, uint256 value, bool allowFailure) call)",
]);

// Define standard ERC20 transfer methods which allow the request id to be appended at the end of calldata
export const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
]);

// Given an array of logs, filter and return the ones which are relevant from the perspective of the oracle
const extractRelevantLogs = async (chainId: number, logs: Log[]) => {
  const relevantLogs: Log[] = [];

  const chain = await getChain(chainId);
  const escrow = chain.metadata.escrow.toLowerCase();

  const parsedLogs = parseEventLogs({
    abi: ABI,
    logs,
    eventName: ["NativeDeposit", "Erc20Deposit", "Transfer", "CallExecuted"],
  });
  await Promise.all(
    parsedLogs.map(async (log) => {
      if (
        log.eventName === "NativeDeposit" &&
        log.address.toLowerCase() === escrow.toLowerCase()
      ) {
        relevantLogs.push(log);
      }

      if (
        log.eventName === "Erc20Deposit" &&
        log.address.toLowerCase() === escrow.toLowerCase()
      ) {
        relevantLogs.push(log);
      }

      if (
        log.eventName === "Transfer" &&
        log.args.to.toLowerCase() === escrow.toLowerCase()
      ) {
        relevantLogs.push(log);
      }

      if (
        log.eventName === "CallExecuted" &&
        log.address.toLowerCase() === escrow.toLowerCase()
      ) {
        relevantLogs.push(log);
      }
    })
  );

  return relevantLogs;
};

// Given an array of logs, extract the relevant ones and send them to the transaction processing queue
export const extractAndProcessLogs = async (chainId: number, logs: Log[]) => {
  const relevantLogs = await extractRelevantLogs(chainId, logs);
  await Promise.all(
    relevantLogs.map(async (log) => {
      if (log.transactionHash) {
        await jobs.mqProcessTransactionEvm.send({
          chainId,
          transactionHash: log.transactionHash.toLowerCase(),
        });
      }
    })
  );
};

// Given all logs of a particular transaction, parse any entries to be tracked by the oracle
export const extractTransactionEntries = async (
  chainId: number,
  transactionReceipt: TransactionReceipt,
  transaction: Lazy<Transaction>
): Promise<TransactionEntry[]> => {
  const transactionEntries: TransactionEntry[] = [];

  const parsedLogs = parseEventLogs({
    abi: ABI,
    logs: await extractRelevantLogs(chainId, transactionReceipt.logs),
    eventName: ["NativeDeposit", "Erc20Deposit", "Transfer", "CallExecuted"],
  });

  // Sort the logs to their original onchain order
  parsedLogs.sort((l1, l2) => l1.logIndex - l2.logIndex);

  for (let i = 0; i < parsedLogs.length; i++) {
    const currentLog = parsedLogs[i];
    const nextLog = i + 1 < parsedLogs.length ? parsedLogs[i + 1] : undefined;

    if (currentLog?.eventName === "NativeDeposit") {
      // If the id is not the zero hash, use it
      let depositId: string | undefined;
      if (currentLog.args.id.toLowerCase() !== zeroHash) {
        depositId = currentLog.args.id.toLowerCase();
      }

      transactionEntries.push({
        chainId,
        transactionId: transactionReceipt.transactionHash,
        entryId: currentLog.logIndex.toString(),
        escrow: currentLog.address.toLowerCase(),
        data: {
          type: "deposit",
          data: {
            depositorAddress: currentLog.args.from.toLowerCase(),
            currencyAddress: zeroAddress,
            amount: currentLog.args.amount.toString(),
            depositId,
          },
        },
      });
    }

    if (currentLog?.eventName === "Transfer") {
      // If the next event in the transaction is a matching `Erc20Deposit` event, take the id from there
      let depositId: string | undefined;
      if (
        nextLog &&
        nextLog.logIndex === currentLog.logIndex + 1 &&
        nextLog.eventName === "Erc20Deposit" &&
        nextLog.args.from.toLowerCase() ===
          currentLog.args.from.toLowerCase() &&
        nextLog.args.token.toLowerCase() === currentLog.address.toLowerCase() &&
        nextLog.args.amount === currentLog.args.amount
      ) {
        depositId = nextLog.args.id;
      }

      // If the transaction involves a single `Transfer` event and the calldata matches a standard ERC20 transfer,
      // take the deposit id from the end of calldata (if the end of calldata has at least 32 bytes)
      if (!depositId && parsedLogs.length === 1) {
        const transactionCalldata = (await transaction()).input;
        const decodedFunctionData = await undefinedOnThrow(() =>
          decodeFunctionData({
            abi: ERC20_ABI,
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
            depositId = "0x" + endOfCalldata.slice(0, 64);
          }
        }
      }

      transactionEntries.push({
        chainId,
        transactionId: transactionReceipt.transactionHash,
        entryId: currentLog.logIndex.toString(),
        escrow: currentLog.args.to.toLowerCase(),
        data: {
          type: "deposit",
          data: {
            depositorAddress: currentLog.args.from.toLowerCase(),
            currencyAddress: currentLog.address.toLowerCase(),
            amount: currentLog.args.amount.toString(),
            depositId,
          },
        },
      });
    }

    if (currentLog?.eventName === "CallExecuted") {
      const decodedFunctionData = await undefinedOnThrow(() =>
        decodeFunctionData({
          abi: ERC20_ABI,
          data: currentLog.args.call.data,
        })
      );
      if (!decodedFunctionData) {
        throw new Error("Unable to decode CallExecuted event");
      }

      transactionEntries.push({
        chainId,
        transactionId: transactionReceipt.transactionHash,
        entryId: currentLog.logIndex.toString(),
        escrow: currentLog.address.toLowerCase(),
        data: {
          type: "withdrawal",
          data: {
            currencyAddress: currentLog.args.call.to.toLowerCase(),
            amount:
              decodedFunctionData.functionName === "transfer"
                ? decodedFunctionData.args[0].toLowerCase()
                : decodedFunctionData.args[1].toLowerCase(),
            withdrawalId: currentLog.args.id,
          },
        },
      });
    }
  }

  return transactionEntries;
};

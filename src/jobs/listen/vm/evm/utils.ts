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
  "event Withdrawal(address to, address token, uint256 amount, bytes32 id)",
  "event Transfer(address indexed from, address indexed to, uint256 amount)",
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
  const creditAddress = chain.metadata!.creditAddress!;

  const parsedLogs = parseEventLogs({
    abi: ABI,
    logs,
    eventName: ["NativeDeposit", "Erc20Deposit", "Transfer", "Withdrawal"],
  });
  await Promise.all(
    parsedLogs.map(async (log) => {
      if (
        log.eventName === "NativeDeposit" &&
        log.address.toLowerCase() === creditAddress.toLowerCase()
      ) {
        relevantLogs.push(log);
      }

      if (
        log.eventName === "Erc20Deposit" &&
        log.address.toLowerCase() === creditAddress.toLowerCase()
      ) {
        relevantLogs.push(log);
      }

      if (
        log.eventName === "Transfer" &&
        log.args.to.toLowerCase() === creditAddress.toLowerCase()
      ) {
        relevantLogs.push(log);
      }

      if (
        log.eventName === "Withdrawal" &&
        log.address.toLowerCase() === creditAddress.toLowerCase()
      ) {
        relevantLogs.push(log);
      }
    })
  );

  return relevantLogs;
};

// Given an array of logs, extract the relevant ones and send them to the transaction processing job
export const extractAndProcessLogs = async (chainId: number, logs: Log[]) => {
  const relevantLogs = await extractRelevantLogs(chainId, logs);
  await Promise.all(
    relevantLogs.map(async (log) => {
      if (log.transactionHash) {
        // One job sent without waiting for finalization
        await jobs.mqProcessTransactionEvm.send({
          chainId,
          transactionHash: log.transactionHash.toLowerCase(),
        });

        // Another job sent waiting for finalization
        await jobs.mqProcessTransactionEvm.send({
          chainId,
          transactionHash: log.transactionHash.toLowerCase(),
          waitForFinalization: true,
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
    eventName: ["NativeDeposit", "Erc20Deposit", "Transfer", "Withdrawal"],
  });

  // Sort the logs to their original onchain order
  parsedLogs.sort((l1, l2) => l1.logIndex - l2.logIndex);

  for (let i = 0; i < parsedLogs.length; i++) {
    const currentLog = parsedLogs[i];
    const nextLog = i + 1 < parsedLogs.length ? parsedLogs[i + 1] : undefined;

    if (currentLog?.eventName === "NativeDeposit") {
      // Case 1:
      // If the id is not the zero hash, associate the deposit to a commitment instead of the sender
      let commitmentId: string | undefined;
      if (currentLog.args.id.toLowerCase() !== zeroHash) {
        commitmentId = currentLog.args.id.toLowerCase();
      }

      transactionEntries.push({
        chainId,
        transactionId: transactionReceipt.transactionHash,
        entryId: currentLog.logIndex.toString(),
        ownerAddress: currentLog.args.from.toLowerCase(),
        currencyAddress: zeroAddress,
        balanceDiff: currentLog.args.amount.toString(),
        commitmentId,
      });
    }

    if (currentLog?.eventName === "Transfer") {
      // Case 1:
      // If the next event in the transaction is a matching `Erc20Deposit` event, then take the commitment id from there
      let commitmentId: string | undefined;
      if (
        nextLog &&
        nextLog.logIndex === currentLog.logIndex + 1 &&
        nextLog.eventName === "Erc20Deposit" &&
        nextLog.args.from.toLowerCase() ===
          currentLog.args.from.toLowerCase() &&
        nextLog.args.token.toLowerCase() === currentLog.address.toLowerCase() &&
        nextLog.args.amount === currentLog.args.amount
      ) {
        commitmentId = nextLog.args.id;
      }

      // Case 2:
      // If the transaction involves a single `Transfer` event and the calldata matches a standard ERC20 transfer method,
      // then take the commitment id from the end of calldata (if the end of calldata has at least 32 bytes)
      if (!commitmentId && parsedLogs.length === 1) {
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
              4 * 2 +
              // Either 64 or 96 bytes depending on the called method
              64 * (decodedFunctionData.functionName === "transfer" ? 2 : 3)
          );
          if (endOfCalldata.length >= 64) {
            commitmentId = "0x" + endOfCalldata;
          }
        }
      }

      transactionEntries.push({
        chainId,
        transactionId: transactionReceipt.transactionHash,
        entryId: currentLog.logIndex.toString(),
        ownerAddress: currentLog.args.from.toLowerCase(),
        currencyAddress: currentLog.address.toLowerCase(),
        balanceDiff: currentLog.args.amount.toString(),
        commitmentId,
      });
    }

    if (currentLog?.eventName === "Withdrawal") {
      // TODO: Implement
    }
  }

  return transactionEntries;
};

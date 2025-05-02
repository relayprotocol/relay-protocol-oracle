import {
  decodeOrderCall,
  decodeOrderExtraData,
  decodeWithdrawal,
  EscrowDepositMessage,
  EscrowWithdrawalMessage,
  EscrowWithdrawalStatus,
  getDecodedWithdrawalId,
} from "@reservoir0x/relay-protocol-sdk";

import {
  Address,
  decodeFunctionData,
  getContract,
  Hex,
  parseAbi,
  parseEventLogs,
  zeroAddress,
  zeroHash,
} from "viem";

import { getOnchainId } from "../utils";
import { getChain } from "../../../../common/chains";
import { externalError } from "../../../../common/error";
import { undefinedOnThrow } from "../../../../common/utils";
import { httpRpc } from "../../../../common/vm/ethereum-vm/rpc";
import { VmAttestor } from "../../vm/types";

export const ABI = parseAbi([
  "event EscrowNativeDeposit(address from, uint256 amount, bytes32 id)",
  "event EscrowErc20Deposit(address from, address token, uint256 amount, bytes32 id)",
  "event SolverNativeTransfer(address to, uint256 amount)",
  "event SolverCallExecuted(address to, bytes data, uint256 amount)",
  "event Transfer(address indexed from, address indexed to, uint256 amount)",
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function callRequests(bytes32 withdrawalId) view returns (bool)",
]);

export class EthereumVmAttestor extends VmAttestor {
  public async getEscrowDepositMessages(
    chainId: string,
    transactionId: string
  ): Promise<EscrowDepositMessage[]> {
    const rpc = await httpRpc(chainId);

    // Ensure the transaction was successfully included
    const receipt = await rpc.getTransactionReceipt({
      hash: transactionId as Hex,
    });
    if (!receipt || receipt.status !== "success") {
      throw externalError(`Missing or reverted transaction ${transactionId}`);
    }

    const chain = await getChain(chainId);

    // Parse and filter the logs we're interested in
    const parsedLogs = parseEventLogs({
      abi: ABI,
      logs: receipt.logs,
      eventName: ["EscrowNativeDeposit", "EscrowErc20Deposit", "Transfer"],
    }).filter((log) => {
      if (
        log.eventName === "EscrowNativeDeposit" &&
        log.address.toLowerCase() === chain.escrow.toLowerCase()
      ) {
        return true;
      }

      if (
        log.eventName === "EscrowErc20Deposit" &&
        log.address.toLowerCase() === chain.escrow.toLowerCase()
      ) {
        return true;
      }

      if (
        log.eventName === "Transfer" &&
        log.args.to.toLowerCase() === chain.escrow.toLowerCase()
      ) {
        return true;
      }

      return false;
    });

    // Sort the logs accordigng to their onchain order
    parsedLogs.sort((l1, l2) => l1.logIndex - l2.logIndex);

    const messages: EscrowDepositMessage[] = [];
    for (let i = 0; i < parsedLogs.length; i++) {
      const currentLog = parsedLogs[i];
      const nextLog = i + 1 < parsedLogs.length ? parsedLogs[i + 1] : undefined;

      if (currentLog?.eventName === "EscrowNativeDeposit") {
        const depositId = currentLog.args.id.toLowerCase();

        messages.push({
          data: {
            chainId,
            transactionId,
          },
          result: {
            onchainId: getOnchainId(
              chainId,
              transactionId,
              currentLog.logIndex.toString()
            ),
            depositId,
            depositor: currentLog.args.from.toLowerCase(),
            currency: zeroAddress,
            amount: currentLog.args.amount.toString(),
          },
        });
      }

      if (currentLog?.eventName === "Transfer") {
        // If the next event in the transaction is a matching `Erc20Deposit` event, take the id from there
        let depositId: string | undefined;
        if (
          nextLog &&
          nextLog.logIndex === currentLog.logIndex + 1 &&
          nextLog.eventName === "EscrowErc20Deposit" &&
          nextLog.args.from.toLowerCase() ===
            currentLog.args.from.toLowerCase() &&
          nextLog.args.token.toLowerCase() ===
            currentLog.address.toLowerCase() &&
          nextLog.args.amount === currentLog.args.amount &&
          nextLog.args.id !== zeroHash
        ) {
          depositId = nextLog.args.id;
        }

        // If the transaction involves a single `Transfer` event and the calldata matches a standard ERC20 transfer,
        // take the deposit id from the end of calldata (if the end of calldata has at least 32 bytes)
        if (!depositId && parsedLogs.length === 1) {
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
            onchainId: getOnchainId(
              chainId,
              transactionId,
              currentLog.logIndex.toString()
            ),
            depositId: depositId ?? zeroHash,
            depositor: currentLog.args.from.toLowerCase(),
            currency: currentLog.address.toLowerCase(),
            amount: currentLog.args.amount.toString(),
          },
        });
      }
    }

    return messages;
  }

  public async getEscrowWithdrawalMessage(
    chainId: string,
    withdrawal: string
  ): Promise<EscrowWithdrawalMessage> {
    const rpc = await httpRpc(chainId);
    const chain = await getChain(chainId);

    const decodedWithdrawal = decodeWithdrawal(withdrawal, chain.vmType);
    const withdrawalId = getDecodedWithdrawalId(decodedWithdrawal);

    const escrow = getContract({
      address: chain.escrow as Address,
      abi: ABI,
      client: rpc,
    });
    const isExecuted = await escrow.read.callRequests([withdrawalId as Hex]);

    let status: EscrowWithdrawalStatus;
    if (isExecuted) {
      status = EscrowWithdrawalStatus.EXECUTED;
    } else {
      const chainTimestamp = await rpc
        .getBlock()
        .then((block) => block.timestamp);
      if (chainTimestamp > BigInt(decodedWithdrawal.withdrawal.expiration)) {
        status = EscrowWithdrawalStatus.EXPIRED;
      } else {
        status = EscrowWithdrawalStatus.PENDING;
      }
    }

    return {
      data: {
        chainId,
        withdrawal,
      },
      result: {
        withdrawalId,
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
    const receipt = await rpc.getTransactionReceipt({
      hash: transactionId as Hex,
    });
    if (!receipt || receipt.status !== "success") {
      throw externalError(`Missing or reverted transaction ${transactionId}`);
    }

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
        `Missing order hash at the end of calldata for transaction ${transactionId}`
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
      const fillContract = decodeOrderExtraData(
        payment.extraData,
        "ethereum-vm"
      ).extraData.fillContract;
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
    calls: string[]
  ): Promise<boolean> {
    const rpc = await httpRpc(chainId);
    const chain = await getChain(chainId);

    // Ensure the transaction was successfully included
    const receipt = await rpc.getTransactionReceipt({
      hash: transactionId as Hex,
    });
    if (!receipt || receipt.status !== "success") {
      throw externalError(`Missing or reverted transaction ${transactionId}`);
    }

    // Parse and filter the logs we're interested in
    const parsedLogs = parseEventLogs({
      abi: ABI,
      logs: receipt.logs,
      eventName: ["SolverCallExecuted"],
    }).filter((log) => {
      if (
        log.eventName === "SolverCallExecuted" &&
        log.address.toLowerCase() === chain.escrow.toLowerCase()
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
}

import {
  DecodedEthereumVmWithdrawal,
  decodeOrderExtraData,
  decodeWithdrawal,
  DepositoryDepositMessage,
  DepositoryWithdrawalMessage,
  DepositoryWithdrawalStatus,
  getDecodedWithdrawalId,
  getVmTypeNativeCurrency,
} from "@reservoir0x/relay-protocol-sdk";
import * as tronweb from "tronweb";
import { TransactionInfo } from "tronweb/lib/esm/types";
import { zeroHash } from "viem";

import { getOnchainId } from "../utils";
import { VmAttestor } from "../../vm/types";
import { getChain } from "../../../../common/chains";
import { externalError, internalError } from "../../../../common/error";
import { undefinedOnThrow } from "../../../../common/utils";
import { httpRpc } from "../../../../common/vm/tron-vm/rpc";

export const ABI = [
  "event RelayNativeDeposit(address from, uint256 amount, bytes32 id)",
  "event RelayErc20Deposit(address from, address token, uint256 amount, bytes32 id)",
  "event SolverNativeTransfer(address to, uint256 amount)",
  "event SolverCallExecuted(address to, bytes data, uint256 amount)",
  "event Transfer(address indexed from, address indexed to, uint256 amount)",
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function callRequests(bytes32 withdrawalId) view returns (bool)",
];

const VM_TYPE = "tron-vm";

const fromHexAddress = (address: string) => {
  return tronweb.utils.address.fromHex(
    address.replace("0x", tronweb.utils.address.ADDRESS_PREFIX)
  );
};

const parseEventLogs = (options: {
  abi: any;
  logs: any[];
  eventName: string | string[];
}): {
  eventName: string;
  address: string;
  args: any;
  logIndex: number;
}[] => {
  const { abi, logs, eventName } = options;

  const eventNames = Array.isArray(eventName) ? eventName : [eventName];

  const parsedLogs: {
    eventName: string;
    address: string;
    args: any;
    logIndex: number;
  }[] = [];

  const iface = new tronweb.utils.ethersUtils.Interface(abi);

  let logIndex = 0;
  for (const log of logs ?? []) {
    logIndex++;

    try {
      const parsedLog = iface.parseLog({
        topics: log.topics?.map((topic: string) => `0x${topic}`) ?? [],
        data: `0x${log.data ?? ""}`,
      });
      if (!parsedLog) {
        continue;
      }

      if (eventNames.includes(parsedLog.name)) {
        parsedLogs.push({
          eventName: parsedLog.name,
          address: log.address,
          args: parsedLog.args,
          logIndex,
        });
      }
    } catch {
      continue;
    }
  }

  return parsedLogs;
};

export class TronVmAttestor extends VmAttestor {
  public async getDepositoryDepositMessages(
    chainId: string,
    transactionId: string
  ): Promise<DepositoryDepositMessage[]> {
    const rpc = await httpRpc(chainId);

    // Ensure the transaction was successfully included
    const receipt = await rpc.trx
      .getTransactionInfo(transactionId)
      .catch(() => {
        throw externalError(
          `Missing transaction ${transactionId} on chain ${chainId}`
        );
      });
    if (!receipt || !receipt.receipt || receipt.receipt.result !== "SUCCESS") {
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
      logs: receipt.log ?? [],
      eventName: ["RelayNativeDeposit", "RelayErc20Deposit", "Transfer"],
    }).filter((log) => {
      if (
        log.eventName === "RelayNativeDeposit" &&
        fromHexAddress(log.address) === depository
      ) {
        return true;
      }

      if (
        log.eventName === "RelayErc20Deposit" &&
        fromHexAddress(log.address) === depository
      ) {
        return true;
      }

      if (
        log.eventName === "Transfer" &&
        fromHexAddress(log.args.to) === depository
      ) {
        return true;
      }

      return false;
    });

    // Sort the logs according to their onchain order
    parsedLogs.sort((l1, l2) => l1.logIndex - l2.logIndex);

    const messages: DepositoryDepositMessage[] = [];
    for (let i = 0; i < parsedLogs.length; i++) {
      const currentLog = parsedLogs[i];
      const nextLogIndex = i + 1;

      if (currentLog?.eventName === "RelayNativeDeposit") {
        const depositId = currentLog.args.id;

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
            depository,
            depositId,
            depositor: fromHexAddress(currentLog.args.from),
            currency: getVmTypeNativeCurrency(VM_TYPE),
            amount: currentLog.args.amount.toString(),
          },
        });
      }

      if (currentLog?.eventName === "Transfer") {
        let depositor = fromHexAddress(currentLog.args.from);

        // If any of the next events in the transaction is a matching `Erc20Deposit` event, take the id and depositor from there
        let depositId: string | undefined;
        for (let j = nextLogIndex; j < parsedLogs.length; j++) {
          const nextLog = parsedLogs[j];
          if (
            nextLog.eventName === "RelayErc20Deposit" &&
            fromHexAddress(nextLog.args.token) === currentLog.address &&
            nextLog.args.amount.toString() === currentLog.args.amount.toString()
          ) {
            depositor = fromHexAddress(nextLog.args.from);

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
          const transaction = await rpc.trx.getTransaction(transactionId);

          const contractCall = transaction.raw_data.contract[0];
          if (contractCall.type === "TriggerSmartContract") {
            const transactionCalldata = (contractCall.parameter.value as any)
              .data;
            try {
              const iface = new tronweb.utils.ethersUtils.Interface(ABI);
              const decodedFunctionData = await undefinedOnThrow(() =>
                iface.parseTransaction({
                  data: `0x${transactionCalldata}`,
                })
              );
              if (decodedFunctionData) {
                const endOfCalldata = transactionCalldata.slice(
                  // No `0x` prefix for Tron
                  0 +
                    // The 4byte method signature
                    8 +
                    // Either 64 or 96 bytes depending on the called method
                    64 * (decodedFunctionData.name === "transfer" ? 2 : 3)
                );
                if (endOfCalldata.length >= 64) {
                  // We take the first 32 bytes from the end of calldata
                  const parsedId = "0x" + endOfCalldata.slice(0, 64);
                  if (parsedId !== zeroHash) {
                    depositId = parsedId;
                  }
                }
              }
            } catch {
              // Skip errors
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
            depository,
            depositId: depositId ?? zeroHash,
            depositor,
            currency: currentLog.address,
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

    // Use TronWeb contract interface to query if the withdrawal has been executed
    const depositoryContract = await rpc
      .contract()
      .at(tronweb.utils.address.toHex(depository));
    const isExecuted = await depositoryContract.methods
      .callRequests(withdrawalId)
      .call();

    let status: DepositoryWithdrawalStatus;
    if (isExecuted) {
      status = DepositoryWithdrawalStatus.EXECUTED;
    } else {
      const chainTimestamp = await rpc.trx
        .getBlock()
        .then((b) => b.block_header.raw_data.timestamp);
      if (
        BigInt(chainTimestamp) - this._FINALIZATION_TIME >
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
    const receipt = await rpc.trx
      .getTransactionInfo(transactionId)
      .catch(() => {
        throw externalError(
          `Missing transaction ${transactionId} on chain ${chainId}`
        );
      });
    if (!receipt || !receipt.receipt || receipt.receipt.result !== "SUCCESS") {
      throw externalError(
        `Reverted transaction ${transactionId} on chain ${chainId}`
      );
    }

    // Ensure the transaction is finalized
    await this._ensureTxFinalization(chainId, receipt);

    const transactionTimestamp = receipt.blockTimeStamp;
    if (transactionTimestamp > payment.deadline * 1000) {
      // Convert deadline from seconds to milliseconds
      throw externalError(
        `Transaction ${transactionId} executed after deadline`
      );
    }

    const transaction = await rpc.trx.getTransaction(transactionId);
    if (!transaction) {
      throw externalError(`Missing transaction ${transactionId}`);
    }

    const contractCall = transaction.raw_data.contract[0];
    if (contractCall.type === "TriggerSmartContract") {
      const input = (contractCall.parameter.value as any).data;
      if (!input.endsWith(payment.orderHash.slice(2))) {
        throw externalError(
          `Transaction ${transactionId} does not reference order id`
        );
      }
    } else {
      throw externalError(
        `Transaction ${transactionId} does not reference order id`
      );
    }

    // Get logs from transaction receipt
    const logs = receipt.log ?? [];

    if (payment.currency === getVmTypeNativeCurrency(VM_TYPE)) {
      // If the payment involves native currency, check for native transfer events
      const fillContract = decodeOrderExtraData(payment.extraData, VM_TYPE)
        .extraData.fillContract;

      // Parse and filter the logs we're interested in
      return parseEventLogs({
        abi: ABI,
        logs,
        eventName: ["SolverNativeTransfer"],
      })
        .filter(
          (log) =>
            fromHexAddress(fillContract) === log.address &&
            fromHexAddress(log.args.to) === payment.recipient
        )
        .map((log) => log.args.amount)
        .reduce((a, b) => a + b, 0n);
    } else {
      // If the payment involves ERC20 currencies, work off standard transfer events
      return parseEventLogs({
        abi: ABI,
        logs,
        eventName: ["Transfer"],
      })
        .filter(
          (log) =>
            log.address === fromHexAddress(payment.currency) &&
            fromHexAddress(log.args.to) === payment.recipient
        )
        .map((log) => log.args.amount)
        .reduce((a, b) => a + b, 0n);
    }
  }

  public async verifySolverCalls(
    _chainId: string,
    _transactionId: string,
    _calls: string[],
    _extraData: string
  ): Promise<boolean> {
    throw internalError("Not implemented");
  }

  private _FINALIZATION_TIME = 3n * 60n * 1000n;

  private async _ensureTxFinalization(chainId: string, tx: TransactionInfo) {
    const rpc = await httpRpc(chainId);
    const latestBlockTimestamp = await rpc.trx
      .getBlock()
      .then((b) => b.block_header.raw_data.timestamp);
    const txTimestamp = tx.blockTimeStamp;
    if (latestBlockTimestamp - txTimestamp < this._FINALIZATION_TIME) {
      throw externalError(`Transaction ${tx.id} is not finalized`);
    }
  }
}

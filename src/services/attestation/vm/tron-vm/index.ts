import {
  DecodedEthereumVmWithdrawal,
  decodeOrderExtraData,
  decodeWithdrawal,
  DepositoryWithdrawalMessage,
  DepositoryWithdrawalStatus,
  getDecodedWithdrawalId,
  getVmTypeNativeCurrency,
} from "@reservoir0x/relay-protocol-sdk";
import * as tronweb from "tronweb";
import {
  Address,
  decodeFunctionData,
  getContract,
  Hex,
  parseEventLogs,
  TransactionReceipt,
  zeroHash,
} from "viem";

import { ABI } from "../ethereum-vm/index";
import { getDeterministicId } from "../utils";
import { EnhancedDepositoryDepositMessage, VmAttestor } from "../../vm/types";
import { getChain } from "../../../../common/chains";
import { externalError, internalError } from "../../../../common/error";
import { undefinedOnThrow } from "../../../../common/utils";
import { httpRpc } from "../../../../common/vm/tron-vm/rpc";

const VM_TYPE = "tron-vm";

export const fromHexAddress = (address: string) => {
  return tronweb.utils.address.fromHex(
    address.replace("0x", tronweb.utils.address.ADDRESS_PREFIX)
  );
};

export const toHexAddress = (address: string) => {
  return tronweb.utils.address
    .toHex(address)
    .replace(tronweb.utils.address.ADDRESS_PREFIX_REGEX, "0x");
};

export class TronVmAttestor extends VmAttestor {
  public async getDepositoryDepositMessages(
    chainId: string,
    transactionId: string
  ): Promise<EnhancedDepositoryDepositMessage[]> {
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

    // Get the timestamp of the transaction
    const timestamp = await rpc
      .getBlock({ blockNumber: receipt.blockNumber })
      .then((b) => Number(b.timestamp));

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

    const messages: EnhancedDepositoryDepositMessage[] = [];
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
            onchainId: getDeterministicId(
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
          extraData: {
            timestamp: String(timestamp),
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
            fromHexAddress(nextLog.args.token) ===
              fromHexAddress(currentLog.address) &&
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
            currency: fromHexAddress(currentLog.address),
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
      address: toHexAddress(depository) as Address,
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
      orderId: string;
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

    if (!transaction.input.endsWith(payment.orderId.slice(2))) {
      throw externalError(
        `Transaction ${transactionId} does not reference order id`
      );
    }

    if (payment.currency === getVmTypeNativeCurrency(VM_TYPE)) {
      // If the payment involves native currency, check for SolverNativeTransfer events
      const fillContract = decodeOrderExtraData(payment.extraData, VM_TYPE)
        .extraData.fillContract;

      // Parse and filter the logs we're interested in
      return parseEventLogs({
        abi: ABI,
        logs: receipt.logs,
        eventName: ["SolverNativeTransfer"],
      })
        .filter(
          (log) =>
            fromHexAddress(fillContract) === fromHexAddress(log.address) &&
            fromHexAddress(log.args.to) === payment.recipient
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
            fromHexAddress(log.address) === payment.currency &&
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

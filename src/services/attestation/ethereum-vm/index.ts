import { decodeOrderExtraData } from "@reservoir0x/relay-protocol-sdk";

import {
  decodeFunctionData,
  Hex,
  parseAbi,
  parseEventLogs,
  zeroAddress,
  zeroHash,
} from "viem";

import { AttestationService } from "../service";
import { getOnchainId, ProtocolMessage } from "../utils";
import { getChain } from "../../../common/chains";
import { safeError } from "../../../common/error";
import { undefinedOnThrow } from "../../../common/utils";
import { httpRpc } from "../../../common/vm/ethereum-vm/rpc";

export const ABI = parseAbi([
  "event EscrowNativeDeposit(address from, uint256 amount, bytes32 id)",
  "event EscrowErc20Deposit(address from, address token, uint256 amount, bytes32 id)",
  "event EscrowCallExecuted(bytes32 id, (address to, bytes data, uint256 value, bool allowFailure) call)",
  "event SolverNativeTransfer(address to, uint256 amount)",
  "event SolverCallExecuted((address to, bytes data, uint256 value) call)",
  "event Transfer(address indexed from, address indexed to, uint256 amount)",
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
]);

export class EvmAttestationService extends AttestationService {
  protected async getEscrowMessages(
    chainId: number,
    transactionId: string
  ): Promise<ProtocolMessage[]> {
    const rpc = await httpRpc(chainId);

    // Ensure the transaction was successfully included
    const receipt = await rpc.getTransactionReceipt({
      hash: transactionId as Hex,
    });
    if (!receipt || receipt.status !== "success") {
      return [];
    }

    const chain = await getChain(chainId);

    // Parse and filter the logs we're interested in
    const parsedLogs = parseEventLogs({
      abi: ABI,
      logs: receipt.logs,
      eventName: [
        "EscrowNativeDeposit",
        "EscrowErc20Deposit",
        "EscrowCallExecuted",
        "Transfer",
      ],
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
        log.eventName === "EscrowCallExecuted" &&
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

    const messages: ProtocolMessage[] = [];
    for (let i = 0; i < parsedLogs.length; i++) {
      const currentLog = parsedLogs[i];
      const nextLog = i + 1 < parsedLogs.length ? parsedLogs[i + 1] : undefined;

      if (currentLog?.eventName === "EscrowNativeDeposit") {
        const depositId = currentLog.args.id.toLowerCase();

        messages.push({
          type: "escrow-deposit",
          message: {
            onchainId: getOnchainId(
              chainId,
              transactionId,
              currentLog.logIndex.toString()
            ),
            data: {
              chainId,
              transactionId,
            },
            result: {
              depositId,
              escrow: chain.escrow.toLowerCase(),
              depositor: currentLog.args.from.toLowerCase(),
              currency: zeroAddress,
              amount: currentLog.args.amount.toString(),
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
          type: "escrow-deposit",
          message: {
            onchainId: getOnchainId(
              chainId,
              transactionId,
              currentLog.logIndex.toString()
            ),
            data: {
              chainId,
              transactionId,
            },
            result: {
              depositId: depositId ?? zeroHash,
              escrow: chain.escrow.toLowerCase(),
              depositor: currentLog.args.from.toLowerCase(),
              currency: currentLog.address.toLowerCase(),
              amount: currentLog.args.amount.toString(),
            },
          },
        });
      }

      if (currentLog?.eventName === "EscrowCallExecuted") {
        if (currentLog.args.call.value > 0n) {
          messages.push({
            type: "escrow-withdrawal",
            message: {
              onchainId: getOnchainId(
                chainId,
                transactionId,
                currentLog.logIndex.toString()
              ),
              data: {
                chainId,
                transactionId,
              },
              result: {
                withdrawalId: currentLog.args.id.toLowerCase(),
                escrow: chain.escrow.toLowerCase(),
                currency: zeroAddress,
                amount: currentLog.args.call.value.toString(),
              },
            },
          });
        } else {
          const decodedFunctionData = await undefinedOnThrow(() =>
            decodeFunctionData({
              abi: ABI,
              data: currentLog.args.call.data,
            })
          );
          if (!decodedFunctionData) {
            throw new Error("Unable to decode CallExecuted event");
          }

          messages.push({
            type: "escrow-withdrawal",
            message: {
              onchainId: getOnchainId(
                chainId,
                transactionId,
                currentLog.logIndex.toString()
              ),
              data: {
                chainId,
                transactionId,
              },
              result: {
                withdrawalId: currentLog.args.id.toLowerCase(),
                escrow: chain.escrow.toLowerCase(),
                currency: currentLog.args.call.to.toLowerCase(),
                amount:
                  decodedFunctionData.functionName === "transfer"
                    ? decodedFunctionData.args[1].toString()
                    : decodedFunctionData.args[2].toString(),
              },
            },
          });
        }
      }
    }

    return messages;
  }

  protected async getSolverPaidAmount(
    chainId: number,
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
      throw safeError(
        `Missing or reverted transaction receipt: ${transactionId}`
      );
    }

    const transactionTimestamp = await rpc
      .getBlock({ blockNumber: receipt.blockNumber })
      .then((block) => block.timestamp);
    if (transactionTimestamp > payment.deadline) {
      throw safeError(
        `Transaction executed after deadline: ${payment.deadline}`
      );
    }

    const transaction = await rpc.getTransaction({
      hash: transactionId as Hex,
    });
    if (!transaction) {
      throw safeError(`Missing transaction: ${transactionId}`);
    }

    if (!transaction.input.endsWith(payment.orderHash.slice(2))) {
      throw safeError(
        `Missing order has at the end of calldata: ${transactionId}`
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
      // If the payment involves ERC20 currencies, work off standard tansfer events
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
}

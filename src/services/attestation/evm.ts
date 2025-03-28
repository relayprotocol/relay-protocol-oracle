import {
  decodeFunctionData,
  Hex,
  parseAbi,
  parseEventLogs,
  zeroAddress,
  zeroHash,
} from "viem";

import { AttestationMessage, AttestationService } from "./types";
import { getMessageId } from "./utils";
import { getChain } from "../../common/chains";
import { undefinedOnThrow } from "../../common/utils";
import { httpRpc } from "../../common/vm/evm/rpc";

export const ABI = parseAbi([
  "event NativeDeposit(address from, uint256 amount, bytes32 id)",
  "event Erc20Deposit(address from, address token, uint256 amount, bytes32 id)",
  "event Transfer(address indexed from, address indexed to, uint256 amount)",
  "event CallExecuted(bytes32 id, (address to, bytes data, uint256 value, bool allowFailure) call)",
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
]);

export class EvmAttestationService implements AttestationService {
  public async attestEscrowDeposits(
    chainId: number,
    transactionId: string
  ): Promise<AttestationMessage[]> {
    return this._getEscrowMessages(chainId, transactionId).then((messages) =>
      messages.filter((m) => m.kind === "escrow-deposit")
    );
  }

  public async attestEscrowWithdrawals(
    chainId: number,
    transactionId: string
  ): Promise<AttestationMessage[]> {
    return this._getEscrowMessages(chainId, transactionId).then((messages) =>
      messages.filter((m) => m.kind === "escrow-withdrawal")
    );
  }

  private async _getEscrowMessages(
    chainId: number,
    transactionId: string
  ): Promise<AttestationMessage[]> {
    const rpc = await httpRpc(chainId);
    const receipt = await rpc.getTransactionReceipt({
      hash: transactionId as Hex,
    });

    const chain = await getChain(chainId);

    // Parse and filter the logs we're interested in
    const parsedLogs = parseEventLogs({
      abi: ABI,
      logs: receipt.logs,
      eventName: ["NativeDeposit", "Erc20Deposit", "Transfer", "CallExecuted"],
    }).filter((log) => {
      if (
        log.eventName === "NativeDeposit" &&
        log.address.toLowerCase() === chain.escrow.toLowerCase()
      ) {
        return true;
      }

      if (
        log.eventName === "Erc20Deposit" &&
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

      if (
        log.eventName === "CallExecuted" &&
        log.address.toLowerCase() === chain.escrow.toLowerCase()
      ) {
        return true;
      }

      return false;
    });

    // Sort the logs accordigng to their onchain order
    parsedLogs.sort((l1, l2) => l1.logIndex - l2.logIndex);

    const messages: AttestationMessage[] = [];
    for (let i = 0; i < parsedLogs.length; i++) {
      const currentLog = parsedLogs[i];
      const nextLog = i + 1 < parsedLogs.length ? parsedLogs[i + 1] : undefined;

      if (currentLog?.eventName === "NativeDeposit") {
        // If the id is not the zero hash, use it
        let id: string | undefined;
        if (currentLog.args.id.toLowerCase() !== zeroHash) {
          id = currentLog.args.id.toLowerCase();
        }

        messages.push({
          kind: "escrow-deposit",
          messageId: getMessageId(
            chainId,
            transactionId,
            currentLog.logIndex.toString()
          ),
          input: {
            chainId,
            transactionId,
          },
          output: {
            escrow: chain.escrow.toLowerCase(),
            depositor: currentLog.args.from.toLowerCase(),
            currency: zeroAddress,
            amount: currentLog.args.amount.toString(),
            id,
          },
        });
      }

      if (currentLog?.eventName === "Transfer") {
        // If the next event in the transaction is a matching `Erc20Deposit` event, take the id from there
        let id: string | undefined;
        if (
          nextLog &&
          nextLog.logIndex === currentLog.logIndex + 1 &&
          nextLog.eventName === "Erc20Deposit" &&
          nextLog.args.from.toLowerCase() ===
            currentLog.args.from.toLowerCase() &&
          nextLog.args.token.toLowerCase() ===
            currentLog.address.toLowerCase() &&
          nextLog.args.amount === currentLog.args.amount &&
          nextLog.args.id !== zeroHash
        ) {
          id = nextLog.args.id;
        }

        // If the transaction involves a single `Transfer` event and the calldata matches a standard ERC20 transfer,
        // take the deposit id from the end of calldata (if the end of calldata has at least 32 bytes)
        if (!id && parsedLogs.length === 1) {
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
                id = parsedId;
              }
            }
          }
        }

        messages.push({
          kind: "escrow-deposit",
          messageId: getMessageId(
            chainId,
            transactionId,
            currentLog.logIndex.toString()
          ),
          input: {
            chainId,
            transactionId,
          },
          output: {
            escrow: chain.escrow.toLowerCase(),
            depositor: currentLog.args.from.toLowerCase(),
            currency: currentLog.address.toLowerCase(),
            amount: currentLog.args.amount.toString(),
            id,
          },
        });
      }

      if (currentLog?.eventName === "CallExecuted") {
        if (currentLog.args.call.value > 0n) {
          messages.push({
            kind: "escrow-withdrawal",
            messageId: getMessageId(
              chainId,
              transactionId,
              currentLog.logIndex.toString()
            ),
            input: {
              chainId,
              transactionId,
            },
            output: {
              escrow: chain.escrow.toLowerCase(),
              currency: zeroAddress,
              amount: currentLog.args.call.value.toString(),
              id: currentLog.args.id,
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
            kind: "escrow-withdrawal",
            messageId: getMessageId(
              chainId,
              transactionId,
              currentLog.logIndex.toString()
            ),
            input: {
              chainId,
              transactionId,
            },
            output: {
              escrow: chain.escrow.toLowerCase(),
              currency: currentLog.args.call.to.toLowerCase(),
              amount:
                decodedFunctionData.functionName === "transfer"
                  ? decodedFunctionData.args[1].toString()
                  : decodedFunctionData.args[2].toString(),
              id: currentLog.args.id,
            },
          });
        }
      }
    }

    return messages;
  }
}

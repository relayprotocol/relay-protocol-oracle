import { zeroHash } from "viem";

import {
  DepositoryDepositMessage,
  DepositoryWithdrawalMessage,
} from "@reservoir0x/relay-protocol-sdk";

import { getOnchainId } from "../utils";
import { VmAttestor } from "../../vm/types";
import { getChain } from "../../../../common/chains";
import { externalError, internalError } from "../../../../common/error";
import { httpRpc } from "../../../../common/vm/bitcoin-vm/rpc";

const BTC_CURRENCY = "bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8";

export class BitcoinVmAttestor extends VmAttestor {
  public async getDepositoryDepositMessages(
    chainId: string,
    transactionId: string
  ): Promise<DepositoryDepositMessage[]> {
    const rpc = await httpRpc(chainId);

    // Get transaction details
    const transaction = await rpc.getRawTransaction(transactionId);
    if (!transaction) {
      throw externalError(`Missing transaction ${transactionId}`);
    }

    // Ensure the transaction is finalized
    this._ensureTxFinalization(transactionId, transaction);

    // Get chain configuration
    const chain = await getChain(chainId);
    const depository = chain.depository;
    if (!depository) {
      throw externalError("Chain has no depository configured");
    }

    // Get all OP_RETURN messages
    const decodedVouts = this._decodeTxOpReturnVouts(transaction.vout);

    // Extract the deposit id
    let depositId: string | undefined;
    let depositIdIndex: number | undefined;
    for (const { i, opReturn } of decodedVouts) {
      if (opReturn && opReturn.startsWith("0x") && opReturn.length >= 66) {
        // Take the first 32 bytes (64 hex chars + '0x')
        depositId = opReturn.slice(0, 66);
        depositIdIndex = i;
        break;
      }
    }

    // Get the depositor from the first transaction input
    let depositor: string | undefined;
    for (const input of transaction.vin) {
      const inputTransaction = await rpc.getRawTransaction(input.txid);
      const vout = inputTransaction.vout[input.vout];
      if (vout && vout.scriptPubKey && vout.scriptPubKey.address) {
        depositor = vout.scriptPubKey.address;
        break;
      }
    }
    if (!depositor) {
      throw externalError("Could not determine depositor");
    }

    // Get the total amount sent to the depository
    const amount = transaction.vout.reduce((acc, output) => {
      if (output.scriptPubKey?.address === depository) {
        return acc + BigInt(output.value);
      }
      return acc;
    }, 0n);

    return [
      {
        data: {
          chainId,
          transactionId,
        },
        result: {
          onchainId: getOnchainId(
            chainId,
            transactionId,
            (depositIdIndex ?? 0).toString()
          ),
          depository,
          depositId: depositId ?? zeroHash,
          depositor,
          currency: BTC_CURRENCY,
          amount: amount.toString(),
        },
      },
    ];
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

    // Get transaction details
    const transaction = await rpc.getRawTransaction(transactionId);
    if (!transaction) {
      throw externalError(`Transaction ${transactionId} not found`);
    }

    // Ensure the transaction is finalized
    this._ensureTxFinalization(transactionId, transaction);

    const transactionTimestamp = await rpc
      .getRawTransaction(transactionId)
      .then((tx) => rpc.getBlock(tx.blockhash))
      .then((block) => block.time);
    if (transactionTimestamp > payment.deadline) {
      throw externalError(
        `Transaction ${transactionId} executed after deadline`
      );
    }

    const decodedVouts = this._decodeTxOpReturnVouts(transaction.vout);
    if (!decodedVouts.some(({ opReturn }) => opReturn === payment.orderHash)) {
      throw externalError(
        `Transaction ${transactionId} does not reference order hash`
      );
    }

    // Find the amount paid to the specified recipient in the transaction outputs
    let paidAmount = BigInt(0);
    for (const output of transaction.vout) {
      // Check if the output address matches the recipient address
      if (output.scriptPubKey.address === payment.recipient) {
        paidAmount += BigInt(output.value);
      }
    }

    return paidAmount;
  }

  public async getDepositoryWithdrawalMessage(
    _chainId: string,
    _withdrawal: string
  ): Promise<DepositoryWithdrawalMessage> {
    throw internalError("Not implemented");
  }

  public verifySolverCalls(
    _chainId: string,
    _transactionId: string,
    _calls: string[],
    _extraData: string
  ): Promise<boolean> {
    throw internalError("Not implemented");
  }

  private _FINALIZATION_BLOCKS = 2;

  private async _ensureTxFinalization(
    transactionId: string,
    tx: { confirmations?: number }
  ) {
    if (!tx.confirmations || tx.confirmations < this._FINALIZATION_BLOCKS) {
      throw externalError(`Transaction ${transactionId} is not finalized`);
    }
  }

  private _decodeTxOpReturnVouts(
    vouts: {
      value: number;
      n: number;
      scriptPubKey: {
        asm: string;
        desc: string;
        hex: string;
        type: string;
        address?: string;
      };
    }[]
  ) {
    return vouts.map((output, i) => {
      if (output.scriptPubKey.asm?.startsWith("OP_RETURN")) {
        try {
          if (output.scriptPubKey.hex.slice(2, 4) === "4c") {
            return {
              i,
              opReturn: Buffer.from(
                output.scriptPubKey.hex.slice(6),
                "hex"
              ).toString("utf8"),
            };
          } else {
            return {
              i,
              opReturn: Buffer.from(
                output.scriptPubKey.hex.slice(4),
                "hex"
              ).toString("utf8"),
            };
          }
        } catch {
          return { i, opReturn: undefined };
        }
      }

      return { i, opReturn: undefined };
    });
  }
}

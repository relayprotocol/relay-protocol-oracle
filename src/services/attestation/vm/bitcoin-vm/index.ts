import {
  decodeWithdrawal,
  DepositoryDepositMessage,
  DepositoryWithdrawalMessage,
  DepositoryWithdrawalStatus,
  getDecodedWithdrawalId,
} from "@reservoir0x/relay-protocol-sdk";
import { externalError, internalError } from "../../../../common/error";
import { httpRpc } from "../../../../common/vm/bitcoin-vm/rpc";
import { VmAttestor } from "../../vm/types";
import { getOnchainId } from "../utils";
import { getChain } from "../../../../common/chains";
import { zeroHash } from "viem";

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
    
    // Ensure the transaction is confirmed
    if (!transaction.confirmations || transaction.confirmations < 1) {
      throw externalError(`Transaction ${transactionId} is not confirmed`);
    }
  
    // Get chain configuration
    const chain = await getChain(chainId);
    const depository = chain.depository;
    if (!depository) {
      throw externalError("Chain has no depository configured");
    }
  
    // Find and decode OP_RETURN outputs for potential deposit IDs
    const opReturnMessages = transaction.vout
      .filter((output) => output.scriptPubKey.asm?.startsWith("OP_RETURN"))
      .map((output) => output.scriptPubKey.hex)
      .map((hex: string) => {
        try {
          if (hex.slice(2, 4) === "4c") {
            return Buffer.from(hex.slice(6), "hex").toString("utf8");
          } else {
            return Buffer.from(hex.slice(4), "hex").toString("utf8");
          }
        } catch {
          return "";
        }
      });
  
    // Extract potential deposit IDs from OP_RETURN data
    let depositId: string | undefined;
    for (const message of opReturnMessages) {
      if (message.startsWith("0x")) {
        depositId = message.slice(0, 66); // Take the first 32 bytes (64 hex chars + '0x')
        break;
      }
    }
  
    // Determine the sender by looking up input transactions
    let depositor: string | undefined;
    for (const input of transaction.vin) {
      try {
        if (input.txid) {
          const inputTransaction = await rpc.getRawTransaction(input.txid);
          const vout = inputTransaction.vout[input.vout];
          if (vout && vout.scriptPubKey && vout.scriptPubKey.address) {
            depositor = vout.scriptPubKey.address;
            break;
          }
        }
      } catch {
        // Ignore errors and try next input
      }
    }
  
    // If we couldn't determine the depositor, use a fallback
    if (!depositor) {
      throw externalError("Could not determine depositor");
    }
  
    // Find outputs that are sent to the depository address
    const messages: DepositoryDepositMessage[] = [];
    for (let i = 0; i < transaction.vout.length; i++) {
      const output = transaction.vout[i];
      
      // Check if this output is sent to the depository address
      if (output.scriptPubKey.address?.toLowerCase() === depository.toLowerCase()) {
        messages.push({
          data: {
            chainId,
            transactionId,
          },
          result: {
            onchainId: getOnchainId(
              chainId,
              transactionId,
              output.n.toString()
            ),
            depository,
            depositId: depositId || zeroHash,
            depositor,
            currency: "0x0000000000000000000000000000000000000000", // Bitcoin uses native currency
            amount: output.value.toString(),
          },
        });
      }
    }
  
    return messages;
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
    
    // Ensure transaction is confirmed
    if (!transaction.confirmations || transaction.confirmations < 1) {
      throw externalError(`Transaction ${transactionId} is not confirmed`);
    }
    
    // TODO: Check if the transaction has expired
    
    // Find the amount paid to the specified recipient in the transaction outputs
    let paidAmount = BigInt(0);
    
    for (const output of transaction.vout) {
      // Check if the output address matches the recipient address
      if (output.scriptPubKey.address?.toLowerCase() === payment.recipient.toLowerCase()) {
        paidAmount += BigInt(output.value);
      }
    }
    
    return paidAmount;
  }

  public async getDepositoryWithdrawalMessage(
    _chainId: string,
    _withdrawal: string
  ): Promise<DepositoryWithdrawalMessage> {
    throw internalError("Not implemented (getDepositoryDepositMessages)");
  }

  public verifySolverCalls(
    _chainId: string,
    _transactionId: string,
    _calls: string[],
    _extraData: string
  ): Promise<boolean> {
    throw internalError("Not implemented");
  }
}

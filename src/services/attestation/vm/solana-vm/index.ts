import { BorshEventCoder, Idl } from "@coral-xyz/anchor";
import {
  EscrowDepositMessage,
  EscrowWithdrawalMessage,
} from "@reservoir0x/relay-protocol-sdk";
import { MEMO_PROGRAM_ID } from "@solana/spl-memo";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";

import { RelayEscrowIdl } from "./idls/RelayEscrowIdl";
import { getOnchainId } from "../utils";
import { getChain } from "../../../../common/chains";
import { externalError, internalError } from "../../../../common/error";
import { httpRpc } from "../../../../common/vm/solana-vm/rpc";
import { VmAttestor } from "../../vm/types";

interface DepositEventData {
  depositor: PublicKey;
  token: PublicKey | null;
  amount: bigint;
  id: number[];
}

export class SolanaVmAttestor extends VmAttestor {
  private readonly eventCoder: BorshEventCoder;

  constructor() {
    super();

    this.eventCoder = new BorshEventCoder(RelayEscrowIdl as Idl);
  }

  public async getEscrowDepositMessages(
    chainId: string,
    transactionId: string
  ): Promise<EscrowDepositMessage[]> {
    const connection = await httpRpc(chainId);
    const transaction = await connection.getParsedTransaction(transactionId, {
      maxSupportedTransactionVersion: 0,
    });

    if (!transaction?.meta?.logMessages) {
      return [];
    }

    return this.parseTransactionLogs(
      chainId,
      transactionId,
      transaction.meta.logMessages,
      await getChain(chainId).then((chain) => chain.escrow)
    );
  }

  public async getEscrowWithdrawalMessage(
    _chainId: string,
    _withdrawal: string
  ): Promise<EscrowWithdrawalMessage> {
    throw internalError("Not implemented");
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
    const connection = await httpRpc(chainId);
    // Get the transaction details
    const transaction = await connection.getTransaction(transactionId, {
      maxSupportedTransactionVersion: 0,
    });
    if (!transaction) {
      throw externalError(`Missing transaction: ${transactionId}`);
    }

    if (transaction.meta?.err) {
      throw externalError(`Transaction failed: ${transactionId}`);
    }

    // Check deadline
    if (transaction.blockTime && transaction.blockTime > payment.deadline) {
      throw externalError(
        `Transaction executed after deadline: ${payment.deadline}`
      );
    }

    // Check that transaction contains the order hash in the memo
    const message = transaction.transaction.message;
    const instructions = [
      ...message.compiledInstructions,
      // Include any inner instructions
      ...(transaction.meta?.innerInstructions ?? [])
        .map((i) => i.instructions)
        .flat()
        .map((i) => ({
          accountKeyIndexes: i.accounts,
          programIdIndex: i.programIdIndex,
          data: bs58.decode(i.data),
        })),
    ];

    const accountKeys = [
      ...message.getAccountKeys({
        addressLookupTableAccounts: await Promise.all(
          (transaction.transaction.message.addressTableLookups ?? []).map(
            async ({ accountKey }) =>
              await connection
                .getAddressLookupTable(accountKey)
                .then((res) => res.value!)
          )
        ),
      }).staticAccountKeys,
      // First we have `writable` and then `readonly`
      ...(transaction.meta?.loadedAddresses?.writable ?? []),
      ...(transaction.meta?.loadedAddresses?.readonly ?? []),
    ];

    let hasOrderHash = false;
    for (const instruction of instructions) {
      const programId = accountKeys[instruction.programIdIndex];
      if (programId.toBase58() === MEMO_PROGRAM_ID.toBase58()) {
        const ixData = Buffer.from(instruction.data).toString();
        if (ixData.includes(payment.orderHash)) {
          hasOrderHash = true;
          break;
        }
      }
    }

    if (!hasOrderHash) {
      throw externalError(
        `Transaction does not reference order hash: ${transactionId}`
      );
    }

    // For native SOL transfers
    if (payment.currency === "11111111111111111111111111111111") {
      const recipientPubkey = new PublicKey(payment.recipient);
      const recipientIndex = accountKeys.findIndex((key) =>
        key.equals(recipientPubkey)
      );
      if (recipientIndex === -1) {
        return 0n;
      }

      const preBalance = transaction.meta?.preBalances?.[recipientIndex] || 0;
      const postBalance = transaction.meta?.postBalances?.[recipientIndex] || 0;
      return BigInt(postBalance) - BigInt(preBalance);
    } else {
      // For SPL token transfers
      const recipientPubkey = new PublicKey(payment.recipient);
      const tokenMintPubkey = new PublicKey(payment.currency);

      // Find pre and post token balances for the recipient and token
      const preTokenBalance = transaction.meta?.preTokenBalances?.find(
        (b) =>
          b.owner === recipientPubkey.toBase58() &&
          b.mint === tokenMintPubkey.toBase58()
      );

      const postTokenBalance = transaction.meta?.postTokenBalances?.find(
        (b) =>
          b.owner === recipientPubkey.toBase58() &&
          b.mint === tokenMintPubkey.toBase58()
      );

      if (!preTokenBalance && !postTokenBalance) {
        return 0n;
      }

      const preAmount = preTokenBalance
        ? BigInt(preTokenBalance.uiTokenAmount.amount)
        : 0n;
      const postAmount = postTokenBalance
        ? BigInt(postTokenBalance.uiTokenAmount.amount)
        : 0n;

      return postAmount - preAmount;
    }
  }

  public verifySolverCalls(
    _chainId: string,
    _transactionId: string,
    _calls: string[]
  ): Promise<boolean> {
    throw internalError("Not implemented");
  }

  private parseTransactionLogs(
    chainId: string,
    transactionId: string,
    logs: string[],
    escrow: string
  ): EscrowDepositMessage[] {
    const messages: EscrowDepositMessage[] = [];

    let messageIndex = 0;
    for (const log of logs) {
      if (!log.startsWith("Program data: ")) {
        continue;
      }

      try {
        const event = this.eventCoder.decode(
          log.slice("Program data: ".length)
        );
        if (!event) {
          continue;
        }

        const message = this.createMessageFromEvent(
          event,
          chainId,
          transactionId,
          messageIndex++,
          escrow
        );
        if (message) {
          messages.push(message);
        }
      } catch {
        // Skip errors
      }
    }

    return messages;
  }

  private createMessageFromEvent(
    event: any,
    chainId: string,
    transactionId: string,
    messageIndex: number,
    escrow: string
  ): EscrowDepositMessage | undefined {
    const onchainId = getOnchainId(
      chainId,
      transactionId,
      messageIndex.toString()
    );

    const input = {
      chainId,
      transactionId,
    };

    switch (event.name) {
      case "DepositEvent": {
        return this.createDepositMessage(
          event.data as DepositEventData,
          onchainId,
          input,
          escrow
        );
      }

      default: {
        return undefined;
      }
    }
  }

  private createDepositMessage(
    event: DepositEventData,
    onchainId: string,
    data: { chainId: string; transactionId: string },
    escrow: string
  ): EscrowDepositMessage {
    return {
      data,
      result: {
        onchainId,
        depositId: "0x" + Buffer.from(event.id).toString("hex"),
        escrow,
        depositor: event.depositor.toBase58(),
        currency: event.token
          ? event.token.toBase58()
          : SystemProgram.programId.toBase58(),
        amount: event.amount.toString(),
      },
    };
  }
}

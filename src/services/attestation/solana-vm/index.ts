import { BorshEventCoder, Idl } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";

import { RelayEscrowIdl } from "./idls/RelayEscrowIdl";
import { AttestationService } from "../service";
import { getOnchainId, ProtocolMessage } from "../utils";
import { getChain } from "../../../common/chains";
import { httpRpc } from "../../../common/vm/solana-vm/rpc";
import { safeError } from "../../../common/error";
import { MEMO_PROGRAM_ID } from "@solana/spl-memo";
import bs58 from "bs58";

interface DepositEventData {
  depositor: PublicKey;
  token: PublicKey | null;
  amount: bigint;
  id: number[];
}

interface TransferExecutedEventData {
  request: {
    recipient: PublicKey;
    token: PublicKey | null;
    amount: bigint;
    nonce: bigint;
    expiration: number;
  };
  executor: PublicKey;
  id: PublicKey;
}

export class SolanaAttestationService extends AttestationService {
  private readonly eventCoder: BorshEventCoder;

  constructor() {
    super();

    this.eventCoder = new BorshEventCoder(RelayEscrowIdl as Idl);
  }

  protected async getEscrowMessages(
    chainId: number,
    transactionId: string
  ): Promise<ProtocolMessage[]> {
    const chain = await getChain(chainId);
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
      chain.escrow
    );
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
    const connection = await httpRpc(chainId);
    // Get the transaction details
    const transaction = await connection.getTransaction(transactionId, {
      maxSupportedTransactionVersion: 0,
    });
    if (!transaction) {
      throw safeError(`Missing transaction: ${transactionId}`);
    }

    if (transaction.meta?.err) {
      throw safeError(`Transaction failed: ${transactionId}`);
    }

    // Check deadline
    if (transaction.blockTime && transaction.blockTime > payment.deadline) {
      throw safeError(`Transaction executed after deadline: ${payment.deadline}`);
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
              await connection.getAddressLookupTable(accountKey).then((res) => res.value!)
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
      throw safeError(`Transaction does not reference order hash: ${payment.transactionId}`);
    }

    // For native SOL transfers
    if (payment.currency === "11111111111111111111111111111111") {
      const recipientPubkey = new PublicKey(payment.recipient);
      const recipientIndex = accountKeys.findIndex(key => key.equals(recipientPubkey));
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
        b => b.owner === recipientPubkey.toBase58() && b.mint === tokenMintPubkey.toBase58()
      );

      const postTokenBalance = transaction.meta?.postTokenBalances?.find(
        b => b.owner === recipientPubkey.toBase58() && b.mint === tokenMintPubkey.toBase58()
      );

      if (!preTokenBalance && !postTokenBalance) {
        return 0n;
      }

      const preAmount = preTokenBalance ? BigInt(preTokenBalance.uiTokenAmount.amount) : 0n;
      const postAmount = postTokenBalance ? BigInt(postTokenBalance.uiTokenAmount.amount) : 0n;

      return postAmount - preAmount;
    }
  }

  private parseTransactionLogs(
    chainId: number,
    transactionId: string,
    logs: string[],
    escrowAddress: string
  ): ProtocolMessage[] {
    const messages: ProtocolMessage[] = [];

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
          escrowAddress,
          messageIndex++
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
    chainId: number,
    transactionId: string,
    escrowAddress: string,
    messageIndex: number
  ): ProtocolMessage | undefined {
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
          escrowAddress
        );
      }

      case "TransferExecutedEvent": {
        return this.createWithdrawalMessage(
          event.data as TransferExecutedEventData,
          onchainId,
          input,
          escrowAddress
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
    data: { chainId: number; transactionId: string },
    escrowAddress: string
  ): ProtocolMessage {
    return {
      type: "escrow-deposit",
      message: {
        onchainId,
        data,
        result: {
          depositId: Buffer.from(event.id).toString("hex"),
          escrow: escrowAddress,
          depositor: event.depositor.toBase58(),
          currency: event.token
            ? event.token.toBase58()
            : SystemProgram.programId.toBase58(),
          amount: event.amount.toString(),
        },
      },
    };
  }

  private createWithdrawalMessage(
    event: TransferExecutedEventData,
    onchainId: string,
    data: { chainId: number; transactionId: string },
    escrowAddress: string
  ): ProtocolMessage {
    return {
      type: "escrow-withdrawal",
      message: {
        onchainId,
        data,
        result: {
          withdrawalId: event.id.toBase58(),
          escrow: escrowAddress,
          currency: event.request.token
            ? event.request.token.toBase58()
            : SystemProgram.programId.toBase58(),
          amount: event.request.amount.toString(),
        },
      },
    };
  }
}

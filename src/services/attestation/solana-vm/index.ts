import { BorshEventCoder, Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

import { RelayEscrowIdl } from "./idls/RelayEscrowIdl";
import {
  AttestationMessage,
  AttestationService,
  EscrowWithdrawalMessage,
  EscrowDepositMessage,
} from "../service";
import { getMessageId } from "../utils";
import { getChain } from "../../../common/chains";
import { httpRpc } from "../../../common/vm/solana-vm/rpc";

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
  ): Promise<AttestationMessage[]> {
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

  protected async getSolverPaidAmount(_data: {
    chainId: number;
    transactionId: string;
    currency: string;
    recipient: string;
    orderHash: string;
    extraData: string;
    deadline: number;
  }): Promise<bigint> {
    throw new Error("Not implemented");
  }

  private parseTransactionLogs(
    chainId: number,
    transactionId: string,
    logs: string[],
    escrowAddress: string
  ): AttestationMessage[] {
    const messages: AttestationMessage[] = [];
    let messageIndex = 0;

    for (const log of logs) {
      if (!log.startsWith("Program data: ")) {
        continue;
      }

      try {
        const event = this.eventCoder.decode(
          log.slice("Program data: ".length)
        );
        if (!event) continue;

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
      } catch (e) {
        console.error("Failed to decode event:", {
          error: e,
          log,
          transactionId,
        });
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
  ): AttestationMessage | null {
    const messageId = getMessageId(
      chainId,
      transactionId,
      messageIndex.toString()
    );

    const input = {
      chainId,
      transactionId,
    };

    switch (event.name) {
      case "DepositEvent":
        return this.createDepositMessage(
          event.data as DepositEventData,
          messageId,
          input,
          escrowAddress
        );
      case "TransferExecutedEvent":
        return this.createWithdrawalMessage(
          event.data as TransferExecutedEventData,
          messageId,
          input,
          escrowAddress
        );
      default:
        return null;
    }
  }

  private createDepositMessage(
    data: DepositEventData,
    messageId: string,
    input: { chainId: number; transactionId: string },
    escrowAddress: string
  ): EscrowDepositMessage {
    return {
      kind: "escrow-deposit",
      messageId,
      input,
      output: {
        escrow: escrowAddress,
        depositor: data.depositor.toBase58(),
        currency: data.token
          ? data.token.toBase58()
          : "11111111111111111111111111111111",
        amount: data.amount.toString(),
        id: Buffer.from(data.id).toString("hex"),
      },
    };
  }

  private createWithdrawalMessage(
    data: TransferExecutedEventData,
    messageId: string,
    input: { chainId: number; transactionId: string },
    escrowAddress: string
  ): EscrowWithdrawalMessage {
    return {
      kind: "escrow-withdrawal",
      messageId,
      input,
      output: {
        escrow: escrowAddress,
        currency: data.request.token
          ? data.request.token.toBase58()
          : "11111111111111111111111111111111",
        amount: data.request.amount.toString(),
        id: data.id.toBase58(),
      },
    };
  }
}

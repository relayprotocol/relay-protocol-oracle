import { BorshEventCoder, Idl } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";

import { RelayEscrowIdl } from "./idls/RelayEscrowIdl";
import { AttestationService } from "../service";
import { getOnchainId, ProtocolMessage } from "../utils";
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
    _chainId: number,
    _transactionId: string,
    _payment: {
      currency: string;
      recipient: string;
      orderHash: string;
      extraData: string;
      deadline: number;
    }
  ): Promise<bigint> {
    throw new Error("Not implemented");
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

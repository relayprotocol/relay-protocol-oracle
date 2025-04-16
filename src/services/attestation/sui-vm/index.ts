import { SuiEvent } from "@mysten/sui/client";

import {
  AttestationMessage,
  EscrowDepositMessage,
  EscrowWithdrawalMessage,
} from "../messages";
import { AttestationService } from "../service";
import { getMessageId } from "../utils";
import { getChain } from "../../../common/chains";
import { httpRpc } from "../../../common/vm/sui-vm/rpc";

interface DepositEventData {
  from: string;
  coin_type: {
    name: string;
  };
  amount: string;
  deposit_id: string;
}

interface TransferExecutedEventData {
  request_hash: number[];
  recipient: string;
  coin_type: {
    name: string;
  };
  amount: bigint;
}

export class SuiAttestationService extends AttestationService {
  protected async getEscrowMessages(
    chainId: number,
    transactionId: string
  ): Promise<AttestationMessage[]> {
    const chain = await getChain(chainId);
    const connection = await httpRpc(chainId);
    const transaction = await connection.getTransactionBlock({
      digest: transactionId,
      options: {
        showEvents: true,
      },
    });

    if (!transaction?.events) {
      return [];
    }

    return this.parseTransactionLogs(
      chainId,
      transactionId,
      transaction.events,
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
    events: SuiEvent[],
    escrowAddress: string
  ): AttestationMessage[] {
    const messages: AttestationMessage[] = [];
    let messageIndex = 0;

    for (const event of events) {
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
    }

    return messages;
  }

  private createMessageFromEvent(
    event: SuiEvent,
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

    if (event.type.includes("DepositEvent")) {
      return this.createDepositMessage(
        event.parsedJson as DepositEventData,
        messageId,
        input,
        escrowAddress
      );
    } else if (event.type.includes("TransferExecutedEvent")) {
      return this.createWithdrawalMessage(
        event.parsedJson as TransferExecutedEventData,
        messageId,
        input,
        escrowAddress
      );
    } else {
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
      data: input,
      result: {
        escrow: escrowAddress,
        depositor: data.from,
        currency: data.coin_type.name,
        amount: data.amount.toString(),
        id: Buffer.from(data.deposit_id).toString("hex"),
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
      data: input,
      result: {
        escrow: escrowAddress,
        currency: data.coin_type.name,
        amount: data.amount.toString(),
        id: Buffer.from(data.request_hash).toString("hex"),
      },
    };
  }
}

import { SuiEvent } from "@mysten/sui/client";

import { AttestationService } from "../service";
import { getOnchainId, ProtocolMessage } from "../utils";
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
  ): Promise<ProtocolMessage[]> {
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
  ): ProtocolMessage[] {
    const messages: ProtocolMessage[] = [];

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

    if (event.type.includes("DepositEvent")) {
      return this.createDepositMessage(
        event.parsedJson as DepositEventData,
        onchainId,
        input,
        escrowAddress
      );
    } else if (event.type.includes("TransferExecutedEvent")) {
      return this.createWithdrawalMessage(
        event.parsedJson as TransferExecutedEventData,
        onchainId,
        input,
        escrowAddress
      );
    } else {
      return undefined;
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
          depositId: Buffer.from(event.deposit_id).toString("hex"),
          escrow: escrowAddress,
          depositor: event.from,
          currency: event.coin_type.name,
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
          withdrawalId: Buffer.from(event.request_hash).toString("hex"),
          escrow: escrowAddress,
          currency: event.coin_type.name,
          amount: event.amount.toString(),
        },
      },
    };
  }
}

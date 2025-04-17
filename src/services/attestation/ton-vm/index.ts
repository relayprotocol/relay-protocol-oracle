import { Address, Message } from "@ton/core";
import { TonClient } from "@ton/ton";

import {
  RelayEscrow,
  DepositEvent,
  WithdrawEvent,
  ADDRESS_NONE,
} from "./wrappers/RelayEscrow";
import { AttestationService } from "../service";
import { getChain } from "../../../common/chains";
import { httpRpc } from "../../../common/vm/ton-vm/rpc";
import { getOnchainId, ProtocolMessage } from "../utils";

export class TonAttestationService extends AttestationService {
  protected async getEscrowMessages(
    chainId: number,
    transactionId: string
  ): Promise<ProtocolMessage[]> {
    const chain = await getChain(chainId);
    const connection = await httpRpc(chainId);
    const [address, lt, hash] = transactionId.split("::");
    const transaction = await connection.getTransaction(
      Address.parse(address),
      lt,
      hash
    );

    if (!transaction?.outMessages) {
      return [];
    }

    return await this.parseTransactionLogs(
      chainId,
      transactionId,
      transaction.outMessages.values(),
      chain.escrow,
      connection
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

  private async parseTransactionLogs(
    chainId: number,
    transactionId: string,
    events: Message[],
    escrowAddress: string,
    connection: TonClient
  ): Promise<ProtocolMessage[]> {
    const messages: ProtocolMessage[] = [];

    let messageIndex = 0;
    for (const event of events) {
      const message = await this.createMessageFromEvent(
        event,
        chainId,
        transactionId,
        escrowAddress,
        messageIndex++,
        connection
      );
      if (message) {
        messages.push(message);
      }
    }

    return messages;
  }

  private async createMessageFromEvent(
    event: Message,
    chainId: number,
    transactionId: string,
    escrowAddress: string,
    messageIndex: number,
    connection: TonClient
  ): Promise<ProtocolMessage | undefined> {
    const onchainId = getOnchainId(
      chainId,
      transactionId,
      messageIndex.toString()
    );

    const input = {
      chainId,
      transactionId,
    };

    const message = await RelayEscrow.parseOutMessage(
      event,
      connection.provider(Address.parse(escrowAddress))
    );

    if (message?.name === "Deposit") {
      return this.createDepositMessage(
        message,
        onchainId,
        input,
        escrowAddress
      );
    } else if (message?.name === "Withdraw") {
      return this.createWithdrawalMessage(
        message,
        onchainId,
        input,
        escrowAddress
      );
    } else {
      return undefined;
    }
  }

  private createDepositMessage(
    event: DepositEvent,
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
          depositId: event.data.depositId.toString(),
          escrow: escrowAddress,
          depositor: event.data.depositor,
          currency:
            event.data.assetType === 0
              ? ADDRESS_NONE.toString()
              : event.data.currency,
          amount: event.data.amount.toString(),
        },
      },
    };
  }

  private createWithdrawalMessage(
    event: WithdrawEvent,
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
          withdrawalId: event.data.msgHash.toString(),
          escrow: escrowAddress,
          currency: event.data.currency,
          amount: event.data.amount.toString(),
        },
      },
    };
  }
}

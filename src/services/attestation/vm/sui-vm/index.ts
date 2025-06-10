import { SuiEvent } from "@mysten/sui/client";
import {
  EscrowDepositMessage,
  EscrowWithdrawalMessage,
} from "@reservoir0x/relay-protocol-sdk";

import { getOnchainId } from "../utils";
import { externalError, internalError } from "../../../../common/error";
import { getChain } from "../../../../common/chains";
import { httpRpc } from "../../../../common/vm/sui-vm/rpc";
import { VmAttestor } from "../../vm/types";

interface DepositEventData {
  from: string;
  coin_type: {
    name: string;
  };
  amount: string;
  deposit_id: string;
}

export class SuiVmAttestor extends VmAttestor {
  public async getEscrowDepositMessages(
    chainId: string,
    transactionId: string
  ): Promise<EscrowDepositMessage[]> {
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

    const chain = await getChain(chainId);
    const escrow = chain.escrow;
    if (!escrow) {
      throw externalError("Chain has no escrow configured");
    }

    return this.parseTransactionLogs(
      chainId,
      transactionId,
      transaction.events,
      escrow
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
    // Get the transaction with all details
    const transaction = await connection.getTransactionBlock({
      digest: transactionId,
      options: {
        showBalanceChanges: true,
        showEffects: true,
        showEvents: true,
      },
    });

    if (!transaction || transaction.effects?.status.status !== "success") {
      throw externalError(`Transaction failed or not found: ${transactionId}`);
    }

    // Check deadline
    const transactionTimestamp = Math.floor(
      Number(transaction.timestampMs) / 1000
    );
    if (transactionTimestamp > payment.deadline) {
      throw externalError(
        `Transaction executed after deadline: ${payment.deadline}`
      );
    }

    // Verify order hash is included in the transaction
    // This could be in a memo event or somewhere in the transaction data
    let orderHashFound = false;
    if (transaction.events) {
      for (const event of transaction.events) {
        // TODO: validate package Id
        if (event.type.includes("::memo::MemoEvent")) {
          const memo = (event.parsedJson as any).message;
          if (memo === payment.orderHash) {
            orderHashFound = true;
            break;
          }
        }
      }
    }

    if (!orderHashFound) {
      throw externalError(
        `Order hash not found in transaction: ${transactionId}`
      );
    }

    // Parse balance changes to find the amount paid to the recipient
    let paidAmount = 0n;

    for (const change of transaction.balanceChanges || []) {
      const ownerAddress =
        (change.owner as any)["AddressOwner"] ||
        (change.owner as any)["ObjectOwner"];

      if (
        ownerAddress &&
        ownerAddress.toLowerCase() === payment.recipient.toLowerCase() &&
        change.coinType === payment.currency &&
        BigInt(change.amount) > 0n
      ) {
        paidAmount += BigInt(change.amount);
      }
    }

    if (paidAmount === 0n) {
      throw externalError(
        `No payment found to recipient: ${payment.recipient}`
      );
    }

    return paidAmount;
  }

  public verifySolverCalls(
    _chainId: string,
    _transactionId: string,
    _calls: string[],
    _extraData: string
  ): Promise<boolean> {
    throw internalError("Not implemented");
  }

  private parseTransactionLogs(
    chainId: string,
    transactionId: string,
    events: SuiEvent[],
    escrow: string
  ): EscrowDepositMessage[] {
    const messages: EscrowDepositMessage[] = [];

    let messageIndex = 0;
    for (const event of events) {
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
    }

    return messages;
  }

  private createMessageFromEvent(
    event: SuiEvent,
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

    if (event.type.includes("DepositEvent")) {
      return this.createDepositMessage(
        event.parsedJson as DepositEventData,
        onchainId,
        input,
        escrow
      );
    } else {
      return undefined;
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
        escrow,
        depositId: Buffer.from(event.deposit_id).toString("hex"),
        depositor: event.from,
        currency: event.coin_type.name,
        amount: event.amount.toString(),
      },
    };
  }
}

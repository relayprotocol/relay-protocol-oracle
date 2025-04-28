import { SuiEvent } from "@mysten/sui/client";
import { EscrowDepositMessage } from "@reservoir0x/relay-protocol-sdk";

import { getOnchainId } from "../../utils";
import { externalError } from "../../../../common/error";
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
    chainId: number,
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

    return this.parseTransactionLogs(
      chainId,
      transactionId,
      transaction.events
    );
  }

  public async getSolverPaidAmount(
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

  private parseTransactionLogs(
    chainId: number,
    transactionId: string,
    events: SuiEvent[]
  ): EscrowDepositMessage[] {
    const messages: EscrowDepositMessage[] = [];

    let messageIndex = 0;
    for (const event of events) {
      const message = this.createMessageFromEvent(
        event,
        chainId,
        transactionId,
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
    messageIndex: number
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
        input
      );
    } else {
      return undefined;
    }
  }

  private createDepositMessage(
    event: DepositEventData,
    onchainId: string,
    data: { chainId: number; transactionId: string }
  ): EscrowDepositMessage {
    return {
      data,
      result: {
        onchainId,
        depositId: Buffer.from(event.deposit_id).toString("hex"),
        depositor: event.from,
        currency: event.coin_type.name,
        amount: event.amount.toString(),
      },
    };
  }
}

import { SuiEvent } from "@mysten/sui/client";
import {
  DecodedSuiVmWithdrawal,
  decodeWithdrawal,
  DepositoryDepositMessage,
  DepositoryWithdrawalMessage,
  DepositoryWithdrawalStatus,
  getDecodedWithdrawalId,
} from "@reservoir0x/relay-protocol-sdk";

import { getOnchainId } from "../utils";
import { externalError, internalError } from "../../../../common/error";
import { getChain } from "../../../../common/chains";
import { httpRpc } from "../../../../common/vm/sui-vm/rpc";
import { VmAttestor } from "../../vm/types";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { bcs } from "@mysten/sui/bcs";

interface DepositEventData {
  from: string;
  coin_type: {
    name: string;
  };
  amount: string;
  deposit_id: string;
}

export class SuiVmAttestor extends VmAttestor {
  public async getDepositoryDepositMessages(
    chainId: string,
    transactionId: string
  ): Promise<DepositoryDepositMessage[]> {
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
    const depository = chain.depository;
    if (!depository) {
      throw externalError("Chain has no depository configured");
    }

    return this.parseTransactionLogs(
      chainId,
      transactionId,
      transaction.events,
      depository
    );
  }

  public async getDepositoryWithdrawalMessage(
    chainId: string,
    withdrawal: string
  ): Promise<DepositoryWithdrawalMessage> {
    const rpc = await httpRpc(chainId);
    const chain = await getChain(chainId);

    const depository = chain.depository;
    if (!depository) {
      throw externalError("Chain has no depository configured");
    }

    const decodedWithdrawal = decodeWithdrawal(
      withdrawal,
      chain.vmType
    ) as DecodedSuiVmWithdrawal;
    const withdrawalId = getDecodedWithdrawalId(decodedWithdrawal);

    let status: DepositoryWithdrawalStatus;
    let onChainStatus: boolean | null = null;
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: `${chain.depository}::depository::check_request_executed`,
        typeArguments: [],
        arguments: [
          // TODO: add EXECUTED_REQUESTS_ID
          tx.object("EXECUTED_REQUESTS_ID"),
          tx.pure.vector("u8", Buffer.from(withdrawalId, "hex")),
        ],
      });

      const randomWallet = new Ed25519Keypair();
      const response = await rpc.devInspectTransactionBlock({
        transactionBlock: tx,
        sender: randomWallet.toSuiAddress(),
      });

      if (!response.results?.[0]?.returnValues?.[0]?.[0]) {
        throw internalError("Failed to cal check_request_executed");
      }
      const isExecuted = bcs.Bool.parse(
        new Uint8Array(response.results[0].returnValues[0][0])
      );
      if (isExecuted) {
        onChainStatus = true;
      }
    } catch {
      // Skip error
    }

    if (onChainStatus) {
      status = DepositoryWithdrawalStatus.EXECUTED;
    } else {
      const latestCheckpointSeq = await rpc.getLatestCheckpointSequenceNumber();
      const checkpoint = await rpc.getCheckpoint({ id: latestCheckpointSeq });
      if (
        BigInt(Number(checkpoint.timestampMs) / 1000) >
        BigInt(decodedWithdrawal.withdrawal.expiration)
      ) {
        status = DepositoryWithdrawalStatus.EXPIRED;
      } else {
        status = DepositoryWithdrawalStatus.PENDING;
      }
    }

    return {
      data: {
        chainId,
        withdrawal,
      },
      result: {
        withdrawalId,
        depository,
        status,
      },
    };
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
    depository: string
  ): DepositoryDepositMessage[] {
    const messages: DepositoryDepositMessage[] = [];

    let messageIndex = 0;
    for (const event of events) {
      const message = this.createMessageFromEvent(
        event,
        chainId,
        transactionId,
        messageIndex++,
        depository
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
    depository: string
  ): DepositoryDepositMessage | undefined {
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
        depository
      );
    } else {
      return undefined;
    }
  }

  private createDepositMessage(
    event: DepositEventData,
    onchainId: string,
    data: { chainId: string; transactionId: string },
    depository: string
  ): DepositoryDepositMessage {
    return {
      data,
      result: {
        onchainId,
        depository,
        depositId: Buffer.from(event.deposit_id).toString("hex"),
        depositor: event.from,
        currency: event.coin_type.name,
        amount: event.amount.toString(),
      },
    };
  }
}

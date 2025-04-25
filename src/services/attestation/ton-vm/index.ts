import { Address, Cell, Message, CommonMessageInfoInternal } from "@ton/core";
import { TonClient, Transaction } from "@ton/ton";

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
import { safeError } from "../../../common/error";
import { parseJettonWalletTransaction, JettonWallet } from "@ton-community/assets-sdk";

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
    const [address, lt, hash] = transactionId.split("::");
    // Get the transaction
    const transaction = await connection.getTransaction(
      Address.parse(address),
      lt,
      hash
    );

    if (!transaction) {
      throw safeError(`Missing transaction: ${transactionId}`);
    }

    // Check deadline
    if (transaction.now > payment.deadline) {
      throw safeError(`Transaction executed after deadline: ${payment.deadline}`);
    }

    // Process both incoming and outgoing transactions to get a complete picture
    const incomingTxs = await traverseIncomingTransactions(connection, transaction);
    const allTransactions = incomingTxs ? [...incomingTxs.transactions] : [transaction];
    
    // Also check outgoing messages from the wallet contract
    const outgoingTxs = await traverseOutgoingTransactions(connection, transaction, []);
    allTransactions.push(...outgoingTxs);

    let totalPaidAmount = 0n;
    let orderHashFound = false;

    for (const tx of allTransactions) {
      try {
        const action = parseJettonWalletTransaction(tx);
        const calledContract = action.transaction.inMessage?.info.dest?.toString();
        if (action.kind === "jetton_transfer") {
          try {
            if (action.forwardPayload) {
              const comment = decodeComment(action.forwardPayload);
              if (comment === payment.orderHash) {
                orderHashFound = true;
              }
            }
          } catch {
            // Decode comment failed
          }

          const jettonWallet = connection.open(
            JettonWallet.createFromAddress(Address.parse(calledContract!))
          );

          // Requires jetton wallet to exist
          const walletData = await jettonWallet.getData();
          const currency = walletData.jettonMaster.toString();

          if (currency.toLowerCase() === payment.currency.toLowerCase() && action.to.toString() === payment.recipient) {
            totalPaidAmount += BigInt(action.amount.toString());
          }
        } else if (action.kind === "text_message") {
          if (action.text === payment.orderHash) {
            orderHashFound = true;
          }

          const jettonWallet = connection.open(
            JettonWallet.createFromAddress(Address.parse(calledContract!))
          );

          // Requires jetton wallet to exist
          const walletData = await jettonWallet.getData();
          const currency = walletData.jettonMaster.toString();

          if (currency.toLowerCase() === payment.currency.toLowerCase() && action.to.toString() === payment.recipient) {
            totalPaidAmount += BigInt(action.amount.toString());
          }
        } else if (action.kind === "simple_transfer") {
          // Native transfer with no comment
          if (ADDRESS_NONE.toString() === payment.currency && action.to.toString() === payment.recipient) {
            totalPaidAmount += BigInt(action.amount.toString());
          }
        }
      } catch {
        // Skip errors
      }
    }

    // Check if we found the orderHash in any of the transactions
    if (!orderHashFound) {
      throw safeError(`Order hash ${payment.orderHash} not found in transaction chain`);
    }

    return totalPaidAmount;
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

const findIncomingTransaction = async (
  client: TonClient,
  transaction: Transaction
): Promise<Transaction | undefined> => {
  const inMessage = transaction.inMessage?.info;
  if (inMessage?.type !== "internal") {
    return undefined;
  }

  return client.tryLocateSourceTx(inMessage.src, inMessage.dest, inMessage.createdLt.toString());
};

export const traverseIncomingTransactions = async (
  client: TonClient,
  transaction: Transaction,
  txs: Transaction[] = []
): Promise<{ transactions: Transaction[] }> => {
  txs.push(transaction);

  const inTx = await findIncomingTransaction(client, transaction);
  if (!inTx) {
    return {
      transactions: txs,
    };
  }

  return traverseIncomingTransactions(client, inTx, txs);
};

const findOutgoingTransactions = async (
  client: TonClient,
  transaction: Transaction
): Promise<Transaction[]> => {
  const outMessagesInfos = transaction.outMessages
    .values()
    .map((message) => message.info)
    .filter((info): info is CommonMessageInfoInternal => info.type === "internal");

  const transactions = await Promise.all(
    outMessagesInfos.map((info) =>
      client.tryLocateResultTx(info.src, info.dest, info.createdLt.toString()).catch(() => null)
    )
  );

  // Filter out null transactions
  return transactions.filter((tx): tx is Transaction => tx !== null);
};

export const traverseOutgoingTransactions = async (
  client: TonClient,
  transaction: Transaction,
  txs: Transaction[] = []
): Promise<Transaction[]> => {
  txs.push(transaction);

  const outTxs = await findOutgoingTransactions(client, transaction);
  if (!outTxs.length) {
    return txs;
  }

  for (const out of outTxs) {
    await traverseOutgoingTransactions(client, out, txs);
  }

  return txs;
};

export const decodeComment = (cell: Cell) => {
  const slice = cell.beginParse();
  slice.loadUint(32);
  return slice.loadStringTail();
};
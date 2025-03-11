import { DbEntry } from "./utils";
import { db } from "../common/db";

export type Transaction = {
  chainId: number;
  transactionId: string;
  data: any;
  block: number;
  timestamp: number;
};

export type TransactionEntry = {
  chainId: number;
  transactionId: string;
  entryId: string;
  ownerAddress: string;
  currencyAddress: string;
  balanceDiff: string;
  commitmentId?: string;
};

export const saveTransaction = async (
  transaction: Transaction
): Promise<DbEntry<Transaction> | undefined> => {
  const result = await db.oneOrNone(
    `
      INSERT INTO transactions (
        chain_id,
        transaction_id,
        data,
        block,
        timestamp
      ) VALUES (
        $/chainId/,
        $/transactionId/,
        $/data:json/,
        $/block/,
        $/timestamp/ 
      ) ON CONFLICT DO NOTHING
      RETURNING *
    `,
    {
      chainId: transaction.chainId,
      transactionId: transaction.transactionId,
      data: transaction.data,
      block: transaction.block,
      timestamp: transaction.timestamp,
    }
  );
  if (!result) {
    return undefined;
  }

  return {
    chainId: result.chain_id,
    transactionId: result.transaction_id,
    data: result.data,
    block: result.block,
    timestamp: result.timestamp,
    createdAt: result.created_at,
    updatedAt: result.updatet_at,
  };
};

export const saveTransactionEntry = async (
  transactionEntry: TransactionEntry
): Promise<DbEntry<TransactionEntry> | undefined> => {
  const result = await db.oneOrNone(
    `
      INSERT INTO transaction_entries (
        chain_id,
        transaction_id,
        entry_id,
        owner_address,
        currency_address,
        balance_diff,
        commitment_id
      ) VALUES (
        $/chainId/,
        $/transactionId/,
        $/entryId/,
        $/ownerAddress/,
        $/currencyAddress/,
        $/balanceDiff/,
        $/commitmentId/
      ) ON CONFLICT DO NOTHING
      RETURNING *
    `,
    {
      chainId: transactionEntry.chainId,
      transactionId: transactionEntry.transactionId,
      entryId: transactionEntry.entryId,
      ownerAddress: transactionEntry.ownerAddress,
      currencyAddress: transactionEntry.currencyAddress,
      balanceDiff: transactionEntry.balanceDiff,
      commitmentId: transactionEntry.commitmentId ?? null,
    }
  );
  if (!result) {
    return undefined;
  }

  return {
    chainId: result.chain_id,
    transactionId: result.transaction_id,
    entryId: result.entry_id,
    ownerAddress: result.owner_address,
    currencyAddress: result.currency_address,
    balanceDiff: result.balance_diff,
    commitmentId: result.commitment_id ?? undefined,
    createdAt: result.created_at,
    updatedAt: result.updated_at,
  };
};

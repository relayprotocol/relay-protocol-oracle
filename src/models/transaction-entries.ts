import { DbEntry } from "./utils";
import { db } from "../common/db";

type Data =
  | {
      type: "deposit";
      data: {
        currencyAddress: string;
        amount: string;
        depositorAddress: string;
        depositId?: string;
      };
    }
  | {
      type: "withdrawal";
      data: {
        currencyAddress: string;
        amount: string;
        withdrawalId: string;
      };
    };

export type TransactionEntry = {
  chainId: number;
  transactionId: string;
  entryId: string;
  escrow: string;
  data: Data;
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
        escrow,
        data
      ) VALUES (
        $/chainId/,
        $/transactionId/,
        $/entryId/,
        $/escrow/,
        $/data:json/
      ) ON CONFLICT DO NOTHING
      RETURNING *
    `,
    {
      chainId: transactionEntry.chainId,
      transactionId: transactionEntry.transactionId,
      entryId: transactionEntry.entryId,
      escrow: transactionEntry.escrow,
      data: transactionEntry.data,
    }
  );
  if (!result) {
    return undefined;
  }

  return {
    chainId: result.chain_id,
    transactionId: result.transaction_id,
    entryId: result.entry_id,
    escrow: result.escrow,
    data: result.data,
    createdAt: result.created_at,
    updatedAt: result.updated_at,
  };
};

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
  data: Data;
};

// Allocator:
// - listens to the oracle
// - the oracle emits two types of messages
//   - deposit messages: deposits from users into the escrow
//     - allocator modifies balance of depositor
//   - withdraw messages: withdrawals to users from the escrow
//     - allocator modifies balance of requester

export const saveTransactionEntry = async (
  transactionEntry: TransactionEntry
): Promise<DbEntry<TransactionEntry> | undefined> => {
  const result = await db.oneOrNone(
    `
      INSERT INTO transaction_entries (
        chain_id,
        transaction_id,
        entry_id,
        data
      ) VALUES (
        $/chainId/,
        $/transactionId/,
        $/entryId/,
        $/data:json/
      ) ON CONFLICT DO NOTHING
      RETURNING *
    `,
    {
      chainId: transactionEntry.chainId,
      transactionId: transactionEntry.transactionId,
      entryId: transactionEntry.entryId,
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
    data: result.data,
    createdAt: result.created_at,
    updatedAt: result.updated_at,
  };
};

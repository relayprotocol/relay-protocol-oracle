// ABOUTME: XRPL JSON-RPC client for xrp-vm — tx / account_info / account_tx.
// ABOUTME: Pins api_version 1 (flat `meta` shape); maps txnNotFound to a typed miss (null).
import axios from "axios";

import { getChain } from "../../chains";

// XRPL JSON-RPC takes a single positional params object and returns { result }.
// api_version 1 keeps tx fields flat with metadata under `meta`; api_version 2
// nests fields under `tx_json` and behaves inconsistently across public nodes.
const API_VERSION = 1;

const REQUEST_TIMEOUT_MS = 10000;

// A native XRP amount is a string of drops; an issued-currency (IOU) amount is
// an object. v1 attests native only, so the object form is rejected downstream.
export type XrpAmount =
  | string
  | { currency: string; issuer: string; value: string };

export interface XrpMemo {
  Memo: {
    MemoData?: string;
    MemoType?: string;
    MemoFormat?: string;
  };
}

export interface XrpTransactionMeta {
  TransactionResult: string;
  // Amount actually delivered. Present on successful payments, absent on tec*
  // (no state change). Always read this instead of `Amount` — partial payments
  // deliver less than `Amount` with tesSUCCESS.
  delivered_amount?: XrpAmount;
}

export interface XrpTransaction {
  hash: string;
  TransactionType: string;
  Account: string;
  Destination?: string;
  DestinationTag?: number;
  Amount?: XrpAmount;
  Fee?: string;
  Sequence?: number;
  LastLedgerSequence?: number;
  Memos?: XrpMemo[];
  Flags?: number;
  // Present on signed txs; part of the SHA512Half signing hash.
  SigningPubKey?: string;
  // Ripple epoch seconds (Unix = date + 946684800).
  date?: number;
  ledger_index?: number;
  validated?: boolean;
  meta: XrpTransactionMeta;
}

// account_info(ledger_index:"validated") returns the account's current sequence
// and the validated ledger it was read against in ONE response — the atomic
// snapshot the withdrawal state machine needs (reading S and L separately opens
// a false-EXPIRED race).
export interface XrpAccountData {
  Sequence: number;
}
export interface XrpAccountInfo {
  account_data: XrpAccountData;
  ledger_index: number;
  validated?: boolean;
}

// Normalized RPC result: a direct rippled node carries the XRPL app-error token in
// `result.error`; `rpc()` maps a dshackle proxy's top-level error into the same field.
interface XrpRpcResult {
  error?: string;
}

class XrpRpcConnection {
  private rpcUrl: string;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
  }

  private async rpc<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<(T & XrpRpcResult) | undefined> {
    // JSON-RPC 2.0 envelope (jsonrpc+id) so both a direct rippled/clio node and a
    // dshackle 2.0 proxy accept it (a direct node ignores the extra fields).
    const { data } = await axios.post(
      this.rpcUrl,
      {
        jsonrpc: "2.0",
        id: 1,
        method,
        params: [{ ...params, api_version: API_VERSION }],
      },
      {
        validateStatus: () => true,
        timeout: REQUEST_TIMEOUT_MS,
      },
    );
    // A direct node carries app errors inside `result.error`; dshackle hoists them to a
    // top-level `error` (no `result`) — re-wrap into the `result.error` token callers use.
    if (data?.result != null) {
      return data.result;
    }
    if (data?.error) {
      const token = String(data.error.message ?? data.error)
        .split(":")[0]
        .trim();
      return { error: token } as T & XrpRpcResult;
    }
    return undefined;
  }

  // Returns null on `txnNotFound` (the caller referenced a tx that does not
  // exist) — distinct from a transport/RPC failure, which throws.
  async getTransaction(transactionId: string): Promise<XrpTransaction | null> {
    const result = await this.rpc<XrpTransaction>("tx", {
      transaction: transactionId,
      binary: false,
    });
    if (!result) {
      throw new Error(`Malformed tx response for ${transactionId}`);
    }
    if (result.error) {
      if (result.error === "txnNotFound") {
        return null;
      }
      throw new Error(`XRPL tx error for ${transactionId}: ${result.error}`);
    }
    return result;
  }

  // Atomic sequence (S) + validated-ledger (L) snapshot. `account` must be a
  // classic r... address — XRPL rejects X-addresses on this endpoint. Returns
  // null when the account does not exist (actNotFound) — distinct from a
  // transport failure.
  async getAccountInfo(account: string): Promise<XrpAccountInfo | null> {
    const result = await this.rpc<XrpAccountInfo>("account_info", {
      account,
      ledger_index: "validated",
    });
    if (!result) {
      throw new Error(`Malformed account_info response for ${account}`);
    }
    if (result.error) {
      if (result.error === "actNotFound") {
        return null;
      }
      throw new Error(`XRPL account_info error for ${account}: ${result.error}`);
    }
    return result;
  }
}

export const httpRpc = async (chainId: string) => {
  const chain = await getChain(chainId);
  return new XrpRpcConnection(chain.httpRpcUrl);
};

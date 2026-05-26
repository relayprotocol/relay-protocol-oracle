// ABOUTME: TonClient (v2) wrapper + raw HTTP helper for masterchain block lookup.
// ABOUTME: lookupMcBlockSeqnoByUtime hits toncenter v2 jsonRPC lookupBlock — not wrapped by @ton/ton.
import { TonClient } from "@ton/ton";

import { Chain, getChain } from "../../chains";
import { externalError } from "../../error";

// Masterchain shard id (workchain -1, shard 0x8000000000000000 as signed int64).
const MASTERCHAIN_SHARD = "-9223372036854775808";

export const httpRpc = async (chainId: string) => {
  const chain = await getChain(chainId);

  const apiKey = chain.additionalData?.rpcApiKey;

  const client = new TonClient({
    endpoint: chain.httpRpcUrl,
    apiKey,
  });

  return { client, chain };
};

// Resolves the masterchain block seqno that contains the given unixtime.
// @ton/ton's TonClient does not wrap toncenter's lookupBlock endpoint, so we
// post the jsonRPC call directly. Reuses chain.httpRpcUrl + rpcApiKey, no
// extra config field needed.
export const lookupMcBlockSeqnoByUtime = async (
  chain: Chain,
  unixtime: number,
): Promise<number> => {
  const apiKey = chain.additionalData?.rpcApiKey;
  const resp = await fetch(chain.httpRpcUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "X-API-Key": apiKey } : {}),
    },
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "lookupBlock",
      params: {
        workchain: -1,
        shard: MASTERCHAIN_SHARD,
        unixtime,
      },
    }),
  });

  if (!resp.ok) {
    throw externalError(
      `lookupBlock HTTP ${resp.status} for chain ${chain.id} unixtime ${unixtime}`,
    );
  }

  const body = (await resp.json()) as {
    ok: boolean;
    result?: { seqno: number };
    error?: string;
  };

  if (!body.ok) {
    // Future unixtime / unfinalized: toncenter returns
    // "LITE_SERVER_NOTREADY: cannot find block ... last known masterchain block: N".
    if (body.error?.includes("cannot find block")) {
      throw externalError(
        `mc block at unixtime ${unixtime} not yet finalized on chain ${chain.id}`,
      );
    }
    throw externalError(
      `lookupBlock failed for chain ${chain.id} unixtime ${unixtime}: ${body.error}`,
    );
  }

  if (typeof body.result?.seqno !== "number") {
    throw externalError(
      `lookupBlock returned malformed result for chain ${chain.id} unixtime ${unixtime}`,
    );
  }

  return body.result.seqno;
};

// Returns the gen_utime of a masterchain block by seqno. Used as validator-
// anchored "current time" for status checks (e.g. Highload V3 PENDING vs
// EXPIRED). @ton/ton's TonClient.HttpApi has getBlockHeader but with a heavy
// zod envelope; we go direct for the same plumbing reason as lookupBlock.
export const getMcBlockUtime = async (
  chain: Chain,
  seqno: number,
): Promise<number> => {
  const apiKey = chain.additionalData?.rpcApiKey;
  const resp = await fetch(chain.httpRpcUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "X-API-Key": apiKey } : {}),
    },
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "getBlockHeader",
      params: {
        workchain: -1,
        shard: MASTERCHAIN_SHARD,
        seqno,
      },
    }),
  });

  if (!resp.ok) {
    throw externalError(
      `getBlockHeader HTTP ${resp.status} for chain ${chain.id} seqno ${seqno}`,
    );
  }

  const body = (await resp.json()) as {
    ok: boolean;
    result?: { gen_utime: number };
    error?: string;
  };

  if (!body.ok) {
    throw externalError(
      `getBlockHeader failed for chain ${chain.id} seqno ${seqno}: ${body.error}`,
    );
  }

  if (typeof body.result?.gen_utime !== "number") {
    throw externalError(
      `getBlockHeader returned malformed result for chain ${chain.id} seqno ${seqno}`,
    );
  }

  return body.result.gen_utime;
};

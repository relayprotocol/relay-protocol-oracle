// ABOUTME: Unit tests for XrpRpcConnection — the two interfaces the oracle uses
// ABOUTME: (tx, account_info) against BOTH dialects: direct rippled + dshackle JSON-RPC 2.0.
import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import axios from "axios";

import { httpRpc } from "../../../../../src/common/vm/xrp-vm/rpc";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock("../../../../../src/common/chains", () => ({
  getChain: async () => ({ httpRpcUrl: "https://xrp.example.invalid/" }),
}));

// A minimal validated native Payment as it appears flat under `result` (both dialects).
const TX = {
  hash: "A".repeat(64),
  TransactionType: "Payment",
  Account: "rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv",
  Destination: "rXzRVoohqvahY4zyUrfmznpVgkLJsDCtd",
  Amount: "2000000",
  validated: true,
  meta: { TransactionResult: "tesSUCCESS", delivered_amount: "2000000" },
};
const ACCT = {
  account_data: { Sequence: 100 },
  ledger_index: 5000,
  validated: true,
};

// Response envelopes. Direct rippled: app errors live INSIDE `result`. dshackle 2.0:
// success under `result`, app errors HOISTED to a top-level `error: { code, message }`.
const directOk = (result: unknown) => ({ data: { result } });
const directErr = (token: string) => ({
  data: { result: { error: token, status: "error", error_message: `${token}: x` } },
});
const dshackleOk = (result: unknown) => ({ data: { jsonrpc: "2.0", id: 1, result } });
const dshackleErr = (token: string, code: number) => ({
  data: { jsonrpc: "2.0", id: 1, error: { code, message: `${token}: some text` } },
});

const TX_HASH = "A".repeat(64);
const ACCOUNT = "rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv";

describe("XrpRpcConnection (dual-dialect)", () => {
  beforeEach(() => {
    mockedAxios.post.mockReset();
  });

  it("sends a JSON-RPC 2.0 envelope (jsonrpc + id) accepted by both a direct node and dshackle", async () => {
    mockedAxios.post.mockResolvedValueOnce(directOk(TX));
    const rpc = await httpRpc("xrp");
    await rpc.getTransaction(TX_HASH);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://xrp.example.invalid/",
      expect.objectContaining({ jsonrpc: "2.0", id: 1, method: "tx" }),
      expect.anything(),
    );
  });

  describe.each([
    { name: "direct rippled", ok: directOk, err: directErr },
    {
      name: "dshackle 2.0",
      ok: dshackleOk,
      err: (t: string) => dshackleErr(t, t === "txnNotFound" ? 29 : 19),
    },
  ])("$name dialect", ({ ok, err }) => {
    it("getTransaction returns the tx on success", async () => {
      mockedAxios.post.mockResolvedValueOnce(ok(TX));
      const rpc = await httpRpc("xrp");
      const tx = await rpc.getTransaction(TX_HASH);
      expect(tx?.hash).toBe(TX_HASH);
      expect(tx?.meta.TransactionResult).toBe("tesSUCCESS");
    });

    it("getTransaction returns null on txnNotFound", async () => {
      mockedAxios.post.mockResolvedValueOnce(err("txnNotFound"));
      const rpc = await httpRpc("xrp");
      expect(await rpc.getTransaction(TX_HASH)).toBeNull();
    });

    it("getTransaction throws on any other error", async () => {
      mockedAxios.post.mockResolvedValueOnce(err("invalidParams"));
      const rpc = await httpRpc("xrp");
      await expect(rpc.getTransaction(TX_HASH)).rejects.toThrow("invalidParams");
    });

    it("getAccountInfo returns the account data on success", async () => {
      mockedAxios.post.mockResolvedValueOnce(ok(ACCT));
      const rpc = await httpRpc("xrp");
      const info = await rpc.getAccountInfo(ACCOUNT);
      expect(info?.account_data.Sequence).toBe(100);
      expect(info?.validated).toBe(true);
    });

    it("getAccountInfo returns null on actNotFound", async () => {
      mockedAxios.post.mockResolvedValueOnce(err("actNotFound"));
      const rpc = await httpRpc("xrp");
      expect(await rpc.getAccountInfo(ACCOUNT)).toBeNull();
    });

    it("getAccountInfo throws on any other error", async () => {
      mockedAxios.post.mockResolvedValueOnce(err("actMalformed"));
      const rpc = await httpRpc("xrp");
      await expect(rpc.getAccountInfo(ACCOUNT)).rejects.toThrow("actMalformed");
    });
  });

  it("throws Malformed when neither result nor error is present", async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { jsonrpc: "2.0", id: 1 } });
    const rpc = await httpRpc("xrp");
    await expect(rpc.getTransaction(TX_HASH)).rejects.toThrow("Malformed tx response");
  });
});

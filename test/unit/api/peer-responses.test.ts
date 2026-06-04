import { describe, expect, it, jest, beforeEach } from "@jest/globals";

jest.mock("axios");

jest.mock("../../../src/common/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const HUB_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HUB_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HUB_C = "0xcccccccccccccccccccccccccccccccccccccccc";
const HUB_D = "0xdddddddddddddddddddddddddddddddddddddddd";
const HUB_E = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const SIGNER_OUTSIDE = "0x9999999999999999999999999999999999999999";

// threshold=2 → need 2 unique peer signers before early-return.
const SIGNERS = new Set([HUB_A, HUB_B, HUB_C, HUB_D, HUB_E]);

const mockConfig: {
  peers?: Record<string, string>;
  peerRequestTimeoutMs: number;
  oracleSigners?: Set<string>;
  oracleSignersThreshold: number;
} = {
  peers: undefined,
  peerRequestTimeoutMs: 10000,
  oracleSigners: undefined,
  oracleSignersThreshold: 0,
};

jest.mock("../../../src/config", () => ({
  get config() {
    return mockConfig;
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const axios = require("axios");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getPeerResponses } = require("../../../src/api/utils");

const sig = (oracleSigner: string) => ({
  oracleChainId: "42161",
  oracleContract: "0xoracle",
  oracleSigner,
  signature: "0xdeadbeef",
});

const delayedResolve = <T>(ms: number, value: T) =>
  new Promise<T>((res) => setTimeout(() => res(value), ms));

const delayedReject = (ms: number, err: any) =>
  new Promise((_, rej) => setTimeout(() => rej(err), ms));

const extractSigs = (data: any) => data.sigs;

describe("getPeerResponses", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig.peers = undefined;
    mockConfig.oracleSigners = undefined;
    mockConfig.oracleSignersThreshold = 0;
  });

  it("returns [] when no peers are configured", async () => {
    const result = await getPeerResponses({
      endpointPath: "/x",
      requestBody: {},
      validateAndExtractResponse: extractSigs,
    });
    expect(result).toEqual([]);
  });

  it("with signers unset: waits for ALL peers", async () => {
    mockConfig.peers = { "http://p1": "k1", "http://p2": "k2", "http://p3": "k3" };

    axios.post = jest
      .fn()
      .mockReturnValueOnce(delayedResolve(10, { data: { sigs: [sig(HUB_A)] } }))
      .mockReturnValueOnce(delayedResolve(20, { data: { sigs: [sig(HUB_B)] } }))
      .mockReturnValueOnce(delayedResolve(500, { data: { sigs: [sig(HUB_C)] } }));

    const start = Date.now();
    const result = await getPeerResponses({
      endpointPath: "/x",
      requestBody: {},
      validateAndExtractResponse: extractSigs,
    });
    const elapsed = Date.now() - start;

    expect(result).toHaveLength(3);
    expect(elapsed).toBeGreaterThanOrEqual(450);
  });

  it("target=2 unique signers: returns after fastest 2 multisig signers", async () => {
    mockConfig.peers = {
      "http://p1": "k1",
      "http://p2": "k2",
      "http://p3": "k3",
      "http://p4": "k4",
      "http://p5": "k5",
    };
    mockConfig.oracleSigners = SIGNERS;
    mockConfig.oracleSignersThreshold = 2;

    axios.post = jest
      .fn()
      .mockReturnValueOnce(delayedResolve(10, { data: { sigs: [sig(HUB_A)] } }))
      .mockReturnValueOnce(delayedResolve(20, { data: { sigs: [sig(HUB_B)] } }))
      .mockReturnValueOnce(delayedResolve(800, { data: { sigs: [sig(HUB_C)] } }))
      .mockReturnValueOnce(delayedResolve(900, { data: { sigs: [sig(HUB_D)] } }))
      .mockReturnValueOnce(delayedResolve(1000, { data: { sigs: [sig(HUB_E)] } }));

    const start = Date.now();
    const result = await getPeerResponses({
      endpointPath: "/x",
      requestBody: {},
      validateAndExtractResponse: extractSigs,
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(400);
    const signers = result.map((s: any) => s.oracleSigner);
    expect(signers).toContain(HUB_A);
    expect(signers).toContain(HUB_B);
    expect(signers).not.toContain(HUB_C);
  });

  it("duplicate signer across peers counts as ONE (e.g. pass-through pair)", async () => {
    mockConfig.peers = { "http://p1": "k1", "http://p2": "k2", "http://p3": "k3" };
    mockConfig.oracleSigners = SIGNERS;
    mockConfig.oracleSignersThreshold = 2;

    axios.post = jest
      .fn()
      .mockReturnValueOnce(delayedResolve(10, { data: { sigs: [sig(HUB_A)] } }))
      .mockReturnValueOnce(delayedResolve(20, { data: { sigs: [sig(HUB_A)] } }))
      .mockReturnValueOnce(delayedResolve(120, { data: { sigs: [sig(HUB_B)] } }));

    const start = Date.now();
    const result = await getPeerResponses({
      endpointPath: "/x",
      requestBody: {},
      validateAndExtractResponse: extractSigs,
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(100); // floor below p3's 120ms — tolerates timer/Date.now jitter
    // RelayOracleMultisig rejects duplicate sorted signers — the returned list
    // must be deduped by oracleSigner, not just counted as unique downstream.
    const returnedSigners = result.map((s: any) => s.oracleSigner);
    expect(returnedSigners).toHaveLength(new Set(returnedSigners).size);
    expect(returnedSigners).toContain(HUB_A);
    expect(returnedSigners).toContain(HUB_B);
  });

  it("threshold=0: skips peer fan-out, returns [] immediately", async () => {
    mockConfig.peers = { "http://p1": "k1", "http://p2": "k2" };
    mockConfig.oracleSigners = new Set([HUB_A, HUB_B]);
    mockConfig.oracleSignersThreshold = 0;

    axios.post = jest.fn();

    const result = await getPeerResponses({
      endpointPath: "/x",
      requestBody: {},
      validateAndExtractResponse: extractSigs,
    });

    expect(result).toEqual([]);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("non-multisig signer does NOT count toward target", async () => {
    mockConfig.peers = { "http://p1": "k1", "http://p2": "k2", "http://p3": "k3" };
    mockConfig.oracleSigners = SIGNERS;
    mockConfig.oracleSignersThreshold = 2;

    axios.post = jest
      .fn()
      .mockReturnValueOnce(
        delayedResolve(10, { data: { sigs: [sig(SIGNER_OUTSIDE)] } }),
      )
      .mockReturnValueOnce(delayedResolve(50, { data: { sigs: [sig(HUB_A)] } }))
      .mockReturnValueOnce(delayedResolve(120, { data: { sigs: [sig(HUB_B)] } }));

    const start = Date.now();
    const result = await getPeerResponses({
      endpointPath: "/x",
      requestBody: {},
      validateAndExtractResponse: extractSigs,
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(100); // floor below p3's 120ms — tolerates timer/Date.now jitter
    const signers = result.map((s: any) => s.oracleSigner);
    expect(signers).toContain(SIGNER_OUTSIDE);
    expect(signers).toContain(HUB_A);
    expect(signers).toContain(HUB_B);
  });

  it("below-target: returns partial set after all peers settle, no error", async () => {
    mockConfig.peers = { "http://p1": "k1", "http://p2": "k2", "http://p3": "k3" };
    mockConfig.oracleSigners = SIGNERS;
    mockConfig.oracleSignersThreshold = 2;

    axios.post = jest
      .fn()
      .mockReturnValueOnce(delayedResolve(10, { data: { sigs: [sig(HUB_A)] } }))
      .mockReturnValueOnce(delayedResolve(20, { data: { sigs: [] } }))
      .mockReturnValueOnce(delayedReject(30, new Error("peer down")));

    const result = await getPeerResponses({
      endpointPath: "/x",
      requestBody: {},
      validateAndExtractResponse: extractSigs,
    });

    expect(result).toHaveLength(1);
    expect(result[0].oracleSigner).toBe(HUB_A);
  });
});

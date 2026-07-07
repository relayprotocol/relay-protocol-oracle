import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { encodeAbiParameters, Hex } from "viem";
import { DepositoryWithdrawalStatus } from "@relay-protocol/settlement-sdk";
import axios from "axios";

import { AttestationService } from "../../../../src/services/attestation";
import { getAuroraHttpRpc } from "../../../../src/common/hub";
import { getBitcoinSignerPubkey } from "../../../../src/services/attestation/utils";

// The hub allocator (wrong) and aurora allocator (correct) addresses are kept
// distinct so the tests catch any regression that queries the wrong contract.
const HUB_ALLOCATOR = "0x6666666666666666666666666666666666666666";
const AURORA_ALLOCATOR = "0x7777777777777777777777777777777777777777";
const AURORA_RPC_URL = "http://aurora-rpc";

jest.mock("../../../../src/services/attestation/vm");
jest.mock("axios", () => ({ post: jest.fn() }));
jest.mock("../../../../src/common/hub", () => ({
  getAuroraHttpRpc: jest.fn(),
  getBalanceOnHub: jest.fn(),
  getHubHttpRpc: jest.fn(),
}));
jest.mock("../../../../src/common/chains", () => ({
  getHubInfo: jest.fn().mockImplementation(async () => ({
    auroraHttpRpcUrl: "http://aurora-rpc",
    allocatorAddress: "0x6666666666666666666666666666666666666666",
    auroraAllocatorAddress: "0x7777777777777777777777777777777777777777",
  })),
  getChain: jest.fn(),
  getChainVmType: jest.fn(),
  getSdkChainsConfig: jest.fn(),
}));
jest.mock("../../../../src/services/attestation/utils", () => {
  const actual = jest.requireActual(
    "../../../../src/services/attestation/utils",
  ) as object;
  return { ...actual, getBitcoinSignerPubkey: jest.fn() };
});

// A real compressed allocator pubkey (signatures are not verified during
// encoding, so any well-formed pubkey + signatures suffice).
const SIGNER_PUBKEY = Buffer.from(
  "022bb028470d521659ee2bae40f79c43bcd8c8f4f53b628dac6b97786649d39a9c",
  "hex",
);

// Two distinct, valid (r, s) signatures for the same input — these are the
// real broadcast vs. attested signatures from the misclassified 0x3777
// withdrawal (input #6).
const SIG_A = {
  r: "2bc07de9d067dc913aab6aec084229ca56296fa5dbe7be24fb358b65c13e050b",
  s: "2d60b53792f10a6fbafcf1f451581bd8c287224ca40b798c8212d2bc187962aa",
};
const SIG_B = {
  r: "2442c665b438dc883c4593b12af01d089435d9e92ac5a938768994eeed2e3b97",
  s: "67f664ef59cdebf4e90e8943aba3cf10325bf7084505bd91759d016b94c132a8",
};

// NEAR MPC signedPayload bytes = hex-encoded JSON (the form stored in
// `signedPayloads` and wrapped inside PayloadWithdrawSigned event data).
const nearSignedPayload = (sig: { r: string; s: string }): Hex => {
  const json = JSON.stringify({
    scheme: "Secp256k1",
    big_r: { affine_point: "02" + sig.r },
    s: { scalar: sig.s },
    recovery_id: 1,
  });
  return ("0x" + Buffer.from(json, "utf8").toString("hex")) as Hex;
};

// abi.encode(bytes) wrapper, mirroring a PayloadWithdrawSigned event's `data`.
const eventData = (sig: { r: string; s: string }): Hex =>
  encodeAbiParameters([{ type: "bytes" }], [nearSignedPayload(sig)]);

// One-input / one-output Bitcoin payload, abi-encoded as the payload builder
// returns it.
const BITCOIN_PAYLOAD: Hex = encodeAbiParameters(
  [
    {
      type: "tuple",
      components: [
        {
          type: "tuple[]",
          name: "inputs",
          components: [
            { type: "bytes", name: "txid" },
            { type: "bytes", name: "index" },
            { type: "bytes", name: "script" },
            { type: "bytes", name: "value" },
          ],
        },
        {
          type: "tuple[]",
          name: "outputs",
          components: [
            { type: "bytes", name: "value" },
            { type: "bytes", name: "script" },
          ],
        },
      ],
    },
  ],
  [
    {
      inputs: [
        {
          txid: ("0x" + "11".repeat(32)) as Hex,
          index: "0x00000000" as Hex,
          script: ("0x0014" + "22".repeat(20)) as Hex,
          value: "0xa086010000000000" as Hex, // 100000 sats, little-endian
        },
      ],
      outputs: [
        {
          value: "0x905f010000000000" as Hex, // 90000 sats, little-endian
          script: ("0x0014" + "33".repeat(20)) as Hex,
        },
      ],
    },
  ],
);

const HASH_TO_SIGN = ("0x" + "ab".repeat(32)) as Hex;

const payloadParams = {
  chainId: "1",
  depository: "0x0987654321098765432109876543210987654321",
  currency: "0x0000000000000000000000000000000000000000",
  amount: "100000",
  spender: "0x1234567890123456789012345678901234567890",
  recipient: "0x1234567890123456789012345678901234567890",
  nonce: ("0x" + "00".repeat(31) + "01") as Hex,
  data: "0x",
};

// Aurora allocator/payload-builder reads, dispatched by function name so the
// (Promise.all) call ordering does not matter.
const setupAuroraReads = (storedSignature: Hex | "0x") => {
  (getAuroraHttpRpc as any).mockResolvedValue({
    readContract: jest.fn(async (params: any) => {
      switch (params.functionName) {
        case "payloadBuilders":
          return "0x1111111111111111111111111111111111111111";
        case "family":
          return "bitcoin-vm";
        case "payloads":
          return BITCOIN_PAYLOAD;
        case "hashToSign":
          return HASH_TO_SIGN;
        case "signedPayloads":
          return storedSignature;
        default:
          throw new Error(`Unexpected read: ${params.functionName}`);
      }
    }),
  } as any);
};

describe("attestDepositoryWithdrawalV2 - re-signed inputs", () => {
  let service: AttestationService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AttestationService();
    (getBitcoinSignerPubkey as any).mockResolvedValue(SIGNER_PUBKEY);
  });

  describe("_getEncodedWithdrawalV2 candidate generation", () => {
    it("returns one encoding per signature when an input was signed twice", async () => {
      setupAuroraReads(nearSignedPayload(SIG_A));
      // The PayloadWithdrawSigned events expose a second, different signature.
      (axios.post as any).mockResolvedValue({
        data: { result: [{ data: eventData(SIG_B) }] },
      });

      const encodings = await (service as any)._getEncodedWithdrawalV2(
        "1",
        payloadParams,
      );

      // One input with two distinct signatures -> two candidate withdrawals.
      expect(encodings).toHaveLength(2);
      expect(encodings[0]).not.toEqual(encodings[1]);
    });

    it("queries the aurora allocator (not the hub allocator) for signatures", async () => {
      setupAuroraReads(nearSignedPayload(SIG_A));
      (axios.post as any).mockResolvedValue({ data: { result: [] } });

      await (service as any)._getEncodedWithdrawalV2("1", payloadParams);

      expect(axios.post).toHaveBeenCalledWith(
        AURORA_RPC_URL,
        expect.objectContaining({
          method: "eth_getLogs",
          params: [expect.objectContaining({ address: AURORA_ALLOCATOR })],
        }),
        expect.objectContaining({ timeout: expect.any(Number) }),
      );
      expect(axios.post).not.toHaveBeenCalledWith(
        AURORA_RPC_URL,
        expect.objectContaining({
          params: [expect.objectContaining({ address: HUB_ALLOCATOR })],
        }),
        expect.objectContaining({ timeout: expect.any(Number) }),
      );
    });

    it("returns a single encoding when the input was signed once", async () => {
      setupAuroraReads(nearSignedPayload(SIG_A));
      // Events only echo the already-stored signature.
      (axios.post as any).mockResolvedValue({
        data: { result: [{ data: eventData(SIG_A) }] },
      });

      const encodings = await (service as any)._getEncodedWithdrawalV2(
        "1",
        payloadParams,
      );

      expect(encodings).toHaveLength(1);
    });

    it("returns no encodings when an input is unsigned", async () => {
      setupAuroraReads("0x");
      (axios.post as any).mockResolvedValue({ data: { result: [] } });

      const encodings = await (service as any)._getEncodedWithdrawalV2(
        "1",
        payloadParams,
      );

      expect(encodings).toEqual([]);
    });
  });

  describe("candidate resolution", () => {
    const withdrawalAddressRequest = {
      chainId: "bitcoin",
      currency: "0x",
      withdrawer: "0x",
      withdrawerChainId: "1",
      recipient: "0x",
      withdrawalNonce: "0x",
    } as any;

    const makeResult = (status: DepositoryWithdrawalStatus, tag: string) => ({
      message: {
        data: { chainId: "bitcoin", withdrawal: tag },
        result: { withdrawalId: tag, depository: "0xdep", status },
      },
      execution: { idempotencyKey: tag, actions: [] },
    });

    const runWith = (candidates: string[]) => {
      jest
        .spyOn(service as any, "_getPayloadParams")
        .mockResolvedValue({} as any);
      jest
        .spyOn(service as any, "_getEncodedWithdrawalV2")
        .mockResolvedValue(candidates as any);
      return jest.spyOn(service, "attestDepositoryWithdrawal");
    };

    const call = () =>
      service.attestDepositoryWithdrawalV2({
        chainId: "bitcoin",
        transactionId: "0xtx",
        withdrawalAddressRequest,
      } as any);

    it("is PENDING when there are no candidate encodings", async () => {
      runWith([]);
      const result = await call();
      expect(result.status).toBe(DepositoryWithdrawalStatus.PENDING);
    });

    it("is EXECUTED (with that execution) when any candidate matches on-chain", async () => {
      const attest = runWith(["w1", "w2"]);
      attest.mockImplementation((async ({ withdrawal }: any) =>
        withdrawal === "w2"
          ? makeResult(DepositoryWithdrawalStatus.EXECUTED, "w2")
          : makeResult(DepositoryWithdrawalStatus.EXPIRED, "w1")) as any);

      const result = await call();

      expect(result.status).toBe(DepositoryWithdrawalStatus.EXECUTED);
      expect(result.execution?.idempotencyKey).toBe("w2");
      // Every candidate is checked.
      expect(attest).toHaveBeenCalledTimes(2);
    });

    it("is EXPIRED when all candidates are expired", async () => {
      const attest = runWith(["w1", "w2"]);
      attest.mockImplementation((async ({ withdrawal }: any) =>
        makeResult(DepositoryWithdrawalStatus.EXPIRED, withdrawal)) as any);

      const result = await call();

      expect(result.status).toBe(DepositoryWithdrawalStatus.EXPIRED);
    });

    it("is PENDING when candidates are not yet spent", async () => {
      const attest = runWith(["w1", "w2"]);
      attest.mockImplementation((async ({ withdrawal }: any) =>
        makeResult(DepositoryWithdrawalStatus.PENDING, withdrawal)) as any);

      const result = await call();

      expect(result.status).toBe(DepositoryWithdrawalStatus.PENDING);
    });
  });
});

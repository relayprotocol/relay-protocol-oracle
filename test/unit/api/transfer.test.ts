import { describe, expect, it, jest, beforeEach } from "@jest/globals";

import endpoint from "../../../src/api/attestations/transfer/v1";
import { verifyOwnerSignature } from "../../../src/common/signature-verification";
import { signExecutionMessage } from "../../../src/common/signer";

const ALIAS = "0xAliasOwner00000000000000000000000000000abcd";
const RECIPIENT = "0xRecipient0000000000000000000000000000abcd";
const EXECUTION = {
  idempotencyKey: "0x" + "11".repeat(32),
  actions: ["0x" + "22".repeat(8)],
};
const SIGN_RESULT = {
  oracleChainId: "hub",
  oracleContract: "0xOracle00000000000000000000000000000000abcd",
  oracleSigner: "0xOracleSigner00000000000000000000000000abcd",
  signature: "0x" + "ab".repeat(65),
};

jest.mock("../../../src/common/chains", () => ({
  getChain: jest.fn(async () => ({ id: "ethereum", vmType: "ethereum-vm" })),
}));

jest.mock("../../../src/common/signature-verification", () => ({
  verifyOwnerSignature: jest.fn(async () => undefined),
}));

jest.mock("../../../src/common/signer", () => ({
  signExecutionMessage: jest.fn(async () => SIGN_RESULT),
}));

// `mock`-prefixed so it can be safely referenced inside the (hoisted) factory.
const mockAttestTransfer = jest.fn(async () => ({
  from: ALIAS,
  to: RECIPIENT,
  execution: EXECUTION,
}));
jest.mock("../../../src/services/attestation", () => ({
  AttestationService: jest.fn(() => ({ attestTransfer: mockAttestTransfer })),
}));

jest.mock("@relay-protocol/settlement-sdk", () => {
  const actual = jest.requireActual(
    "@relay-protocol/settlement-sdk",
  ) as Record<string, unknown>;
  return { ...actual, generateAddress: jest.fn(() => ALIAS) };
});

// config.peers undefined → the peer-signature fan-out is skipped.
jest.mock("../../../src/config", () => ({ config: { peers: undefined } }));

const body = () => ({
  chainId: "base",
  currency: "0xCurrency00000000000000000000000000000abcd",
  amount: "1000000",
  ownerChainId: "ethereum",
  owner: "0xOwner000000000000000000000000000000000abcd",
  recipient: RECIPIENT,
  nonce: "0x" + "00".repeat(31) + "07",
  ownerSignature: "0x" + "ee".repeat(65),
});

const makeReply = () => {
  const reply: any = {};
  reply.send = jest.fn().mockReturnValue(reply);
  return reply;
};

const call = (b: any) =>
  (endpoint as any).handler({ body: b, headers: {} } as any, makeReply());

describe("POST /attestations/transfer/v1", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("verifies alias ownership, then signs a transfer from the alias to the recipient", async () => {
    const reply = makeReply();
    await (endpoint as any).handler(
      { body: body(), headers: {} } as any,
      reply,
    );

    // The owner signature is verified before anything is signed.
    expect(verifyOwnerSignature).toHaveBeenCalledWith({
      data: { ...body(), operation: "transfer" },
      signature: body().ownerSignature,
    });

    // The transfer source is the owner's alias and the signed execution is
    // returned to the caller with the oracle signature attached.
    expect(mockAttestTransfer).toHaveBeenCalledWith({
      chainId: "base",
      currency: body().currency,
      amount: "1000000",
      from: ALIAS,
      to: RECIPIENT,
      nonce: body().nonce,
    });
    expect(signExecutionMessage).toHaveBeenCalledWith(EXECUTION);
    expect(reply.send).toHaveBeenCalledWith({
      execution: { ...EXECUTION, signatures: [SIGN_RESULT] },
    });
  });

  it("propagates an invalid owner signature and does not sign", async () => {
    (verifyOwnerSignature as jest.Mock).mockImplementationOnce(
      async () => {
        throw new Error("Invalid signature");
      },
    );

    await expect(call(body())).rejects.toThrow(/Invalid signature/);
    expect(mockAttestTransfer).not.toHaveBeenCalled();
    expect(signExecutionMessage).not.toHaveBeenCalled();
  });
});

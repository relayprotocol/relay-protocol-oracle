import { describe, expect, it, jest, beforeEach } from "@jest/globals";

import endpoint from "../../../src/api/attestations/withdraw-request-authorization/v1";
import { validateRecoverMode } from "../../../src/common/recover-mode-verification";
import { verifyWithdrawalSignature } from "../../../src/common/signature-verification";
import { signAllocatorWithdrawRequest } from "../../../src/common/signer";

const NORMALIZED = { normalized: true } as any;
const SIGN_RESULT = {
  allocatorChainId: 1,
  allocatorContract: "0xAllocator0000000000000000000000000000abcd",
  oracleSigner: "0xOracleSigner00000000000000000000000000abcd",
  signature: "0x" + "ab".repeat(65),
};

jest.mock("../../../src/common/chains", () => ({
  getChain: jest.fn(async () => ({
    id: "ethereum",
    vmType: "ethereum-vm",
    depository: "0xDep0000000000000000000000000000000000abcd",
  })),
}));

jest.mock("../../../src/common/recover-mode-verification", () => ({
  recoverModeSchemaFields: {},
  validateRecoverMode: jest.fn(async () => undefined),
}));

jest.mock("../../../src/common/signature-verification", () => ({
  verifyWithdrawalSignature: jest.fn(async () => undefined),
}));

jest.mock("../../../src/common/signer", () => ({
  signAllocatorWithdrawRequest: jest.fn(async () => SIGN_RESULT),
}));

jest.mock("../../../src/services/attestation", () => ({
  AttestationService: class {},
}));

jest.mock("../../../src/common/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("@relay-protocol/settlement-sdk", () => {
  const actual = jest.requireActual("@relay-protocol/settlement-sdk") as Record<string, unknown>;
  return { ...actual, normalizeWithdrawRequest: jest.fn(() => NORMALIZED) };
});

// config.peers undefined → the peer-signature fan-out is skipped.
jest.mock("../../../src/config", () => ({ config: { peers: undefined } }));

const recoverBody = () => ({
  chainId: "ethereum",
  currency: "0xCurrency00000000000000000000000000000abcd",
  amount: "1000000",
  spenderChainId: "ethereum",
  spender: "0xOwner000000000000000000000000000000000abcd",
  receiver: "0xRecipient0000000000000000000000000000abcd",
  nonce: "0x" + "00".repeat(31) + "07",
  recoverMode: true,
  depositChainId: "ethereum",
  depositTransactionId: "0x" + "ab".repeat(32),
  depositOnchainId: "0x" + "cd".repeat(32),
  order: { inputs: [] },
  orderSignature: "0x" + "ee".repeat(65),
});

const makeReply = () => {
  const reply: any = {};
  reply.send = jest.fn().mockReturnValue(reply);
  return reply;
};

const call = (body: any) => (endpoint as any).handler({ body, headers: {} } as any, makeReply());

describe("POST /attestations/withdraw-request-authorization/v1 — recoverMode", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("authorizes recoverMode without a user signature and signs the normalized request", async () => {
    const reply = makeReply();
    await (endpoint as any).handler({ body: recoverBody(), headers: {} } as any, reply);

    // recoverMode path: validateRecoverMode runs, the user-signature check does not.
    expect(validateRecoverMode).toHaveBeenCalledTimes(1);
    expect(verifyWithdrawalSignature).not.toHaveBeenCalled();

    // validateRecoverMode receives the request fields it needs to authorize.
    const args = (validateRecoverMode as jest.Mock).mock.calls[0][0] as any;
    expect(args).toMatchObject({
      depositChainId: "ethereum",
      depositOnchainId: "0x" + "cd".repeat(32),
      owner: "0xOwner000000000000000000000000000000000abcd",
      recipient: "0xRecipient0000000000000000000000000000abcd",
      orderSignature: "0x" + "ee".repeat(65),
    });
    expect(args.attestationService).toBeDefined();

    // The exact normalized request returned to the caller is the one that was signed.
    expect(signAllocatorWithdrawRequest).toHaveBeenCalledWith(NORMALIZED);
    expect(reply.send).toHaveBeenCalledWith({
      withdrawRequest: NORMALIZED,
      allocatorChainId: SIGN_RESULT.allocatorChainId,
      allocatorContract: SIGN_RESULT.allocatorContract,
      signatures: [{ oracleSigner: SIGN_RESULT.oracleSigner, signature: SIGN_RESULT.signature }],
    });
  });

  it("propagates a recoverMode rejection and does not sign", async () => {
    (validateRecoverMode as jest.Mock).mockImplementationOnce(async () => {
      throw new Error("recoverMode requires depositChainId, ...");
    });

    await expect(call(recoverBody())).rejects.toThrow(/recoverMode requires/);
    expect(signAllocatorWithdrawRequest).not.toHaveBeenCalled();
  });

  it("still requires ownerSignature on the non-recover path (regression)", async () => {
    const { recoverMode, ...rest } = recoverBody();
    await expect(call(rest)).rejects.toThrow(/ownerSignature is required/);
    expect(validateRecoverMode).not.toHaveBeenCalled();
    expect(signAllocatorWithdrawRequest).not.toHaveBeenCalled();
  });
});

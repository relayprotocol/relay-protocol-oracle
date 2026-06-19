import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import endpoint from "../../../src/api/attestations/depository-withdrawals/v3";
import { signExecutionMessage } from "../../../src/common/signer";

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
  getChain: jest.fn(async () => ({
    id: "bitcoin",
    vmType: "bitcoin-vm",
    depository: "bc1qallocator",
  })),
}));

jest.mock("../../../src/common/signer", () => ({
  signExecutionMessage: jest.fn(async () => SIGN_RESULT),
}));

const mockAttestDepositoryWithdrawalV3 = jest.fn(async () => ({
  status: 2,
  execution: EXECUTION,
}));
jest.mock("../../../src/services/attestation", () => ({
  AttestationService: jest.fn(() => ({
    attestDepositoryWithdrawalV3: mockAttestDepositoryWithdrawalV3,
  })),
}));

jest.mock("../../../src/config", () => ({ config: { peers: undefined } }));

const additionalData = {
  "bitcoin-vm": {
    allocatorUtxos: [
      {
        txid: "0x" + "01".repeat(32),
        vout: 0,
        value: "1000",
      },
    ],
    feeUtxos: [
      {
        txid: "0x" + "02".repeat(32),
        vout: 1,
        value: "2000",
        address: "bc1qfee",
      },
    ],
    feeRate: 2,
    feeChangeAddress: "bc1qchange",
  },
};

const body = () => ({
  chainId: "bitcoin",
  currency: "btc",
  amount: "1000",
  spenderChainId: "ethereum",
  spender: "0xOwner000000000000000000000000000000000abcd",
  receiver: "bc1qreceiver",
  nonce: "0x" + "00".repeat(31) + "07",
  additionalData,
});

const makeReply = () => {
  const reply: any = {};
  reply.send = jest.fn().mockReturnValue(reply);
  return reply;
};

describe("POST /attestations/depository-withdrawals/v3", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("passes withdraw request additionalData through to the attestation service", async () => {
    const reply = makeReply();
    await (endpoint as any).handler(
      { body: body(), headers: {}, originalUrl: endpoint.url } as any,
      reply,
    );

    expect(mockAttestDepositoryWithdrawalV3).toHaveBeenCalledWith({
      chainId: "bitcoin",
      depository: "bc1qallocator",
      currency: "btc",
      amount: "1000",
      spenderChainId: "ethereum",
      spender: "0xOwner000000000000000000000000000000000abcd",
      receiver: "bc1qreceiver",
      nonce: body().nonce,
      additionalData,
      transactionId: undefined,
      hints: undefined,
    });
    expect(signExecutionMessage).toHaveBeenCalledWith(EXECUTION);
    expect(reply.send).toHaveBeenCalledWith({
      status: 2,
      execution: { ...EXECUTION, signatures: [SIGN_RESULT] },
    });
  });
});

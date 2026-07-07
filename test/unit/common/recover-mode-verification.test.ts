import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { Hex, keccak256, verifyMessage } from "viem";

import { Order, getOrderId } from "@relay-protocol/settlement-sdk";

import { validateRecoverMode } from "../../../src/common/recover-mode-verification";
import { AttestationService } from "../../../src/services/attestation";
import { getVmAttestor } from "../../../src/services/attestation/vm";
import { Chain, getSdkChainsConfig } from "../../../src/common/chains";
import { getBalanceOnHub, getHubHttpRpc } from "../../../src/common/hub";

jest.mock("../../../src/services/attestation/vm");
jest.mock("../../../src/common/chains");
jest.mock("../../../src/common/hub", () => ({
  getBalanceOnHub: jest.fn().mockImplementation(() => Promise.resolve(10000n)),
  getHubHttpRpc: jest.fn(),
}));

jest.mock("viem", () => {
  const viem = jest.requireActual("viem") as typeof import("viem");
  return {
    ...viem,
    verifyMessage: jest.fn().mockImplementation(() => Promise.resolve(true)),
    verifyTypedData: jest.fn().mockImplementation(() => Promise.resolve(true)),
  };
});

jest.mock("../../../src/common/chains", () => {
  const chains: Record<string, Chain> = {
    ethereum: {
      id: "ethereum",
      vmType: "ethereum-vm",
      httpRpcUrl: "http://127.0.0.1:8545",
      depository: "0x0987654321098765432109876543210987654321",
      hubChainId: "1",
    },
    solana: {
      id: "solana",
      vmType: "solana-vm",
      httpRpcUrl: "http://127.0.0.1:8899",
      depository: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      hubChainId: "1",
    },
  };
  return {
    getChains: async () => chains,
    getChain: async (chainId: string) => chains[chainId],
    getChainVmType: jest.fn().mockImplementation(async (chainId) => {
      if (chainId === "ethereum") return "ethereum-vm";
      if (chainId === "solana") return "solana-vm";
      throw new Error(`Unknown chain: ${chainId}`);
    }),
    getChainHubChainId: jest.fn().mockImplementation(async () => 1),
    getHubInfo: jest.fn().mockImplementation(async () => ({
      id: "hub",
      evmChainId: "1",
      httpRpcUrl: "http://localhost:8545",
      hubAddress: "0x0000000000000000000000000000000000000001",
      oracleAddress: "0x0000000000000000000000000000000000000002",
      oracleMultisigAddress: "0x0000000000000000000000000000000000000003",
      genericMappingAddress: "0x0000000000000000000000000000000000000004",
      allocatorAddress: "0x0000000000000000000000000000000000000005",
      auroraHttpRpcUrl: "http://localhost:8545",
      auroraEvmChainId: "1313161554",
      auroraAllocatorAddress: "0x0000000000000000000000000000000000000005",
      auroraAllocatorSpenderAddress:
        "0x0000000000000000000000000000000000000006",
      auroraOracleMultisigAddress: "0x0000000000000000000000000000000000000007",
    })),
    getSdkChainsConfig: jest.fn(() => ({
      ethereum: "ethereum-vm",
      solana: "solana-vm",
    })),
  };
});

const mockGetVmAttestor = jest.mocked(getVmAttestor);

describe("validateRecoverMode", () => {
  const service = new AttestationService();

  // Use lowercase canonical form for the order; tests will check that
  // checksum-cased params still match.
  const depositor = "0x1234567890123456789012345678901234567890";
  // Order data sent to the oracle is the raw form built by the solver
  // (chain-native addresses — `normalizeOrder` only runs inside `getOrderId`
  // for hashing, never mutates the stored Order). For ethereum-vm this means
  // refund addresses can be checksum or lowercase; the encode-based compare
  // must tolerate either side appearing in either form.
  const refundRecipientLower = "0xaaaabbbbccccddddeeeeffff0011223344556677";
  const refundRecipientChecksum = "0xaaAAbbBBccCCddDDeeEEffff0011223344556677";
  const solver = "0x0987654321098765432109876543210987654321";
  const currencyLower = "0xdac17f958d2ee523a2206206994597c13d831ec7"; // USDT lowercase
  const currencyChecksum = "0xdAC17F958D2ee523a2206206994597C13D831ec7"; // USDT checksum

  // Solana fixtures — base58 mints / pubkeys. Encoding is bs58 → bytes → hex,
  // so a clean round-trip is the real test of `encodeAddress` for non-EVM VMs.
  const solRecipient = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const solUsdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const solUsdtMint = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
  const amount = "1000";
  const chainId = "ethereum";
  const depositChainId = "ethereum";
  const transactionId =
    "0x552985b36c59902b24fde1437a11a2698347aa5ca2bf82697d0f8e8e1e35cc6e";
  const onchainId =
    "0x0000000000000000000000000000000000000000000000000000000000000999";

  const buildOrder = (overrides?: {
    refundChainId?: string;
    refundRecipient?: string;
    refundCurrency?: string;
    inputCount?: number;
  }): Order => {
    const refundChainId = overrides?.refundChainId ?? chainId;
    const refundRecipient = overrides?.refundRecipient ?? refundRecipientLower;
    const refundCurrency = overrides?.refundCurrency ?? currencyLower;
    const inputCount = overrides?.inputCount ?? 1;
    const input = {
      payment: { chainId, currency: currencyLower, amount, weight: "1" },
      refunds: [
        {
          chainId: refundChainId,
          recipient: refundRecipient,
          currency: refundCurrency,
          minimumAmount: amount,
          deadline: Math.floor(Date.now() / 1000) + 3600,
          extraData: "0x",
        },
      ],
    };
    return {
      version: "v1",
      salt: "0x1",
      solverChainId: chainId,
      solver,
      inputs: Array.from({ length: inputCount }, () => input),
      output: {
        chainId,
        payments: [
          {
            recipient: "0x3333333333333333333333333333333333333333",
            currency: currencyLower,
            minimumAmount: amount,
            expectedAmount: amount,
          },
        ],
        calls: [],
        extraData: "0x",
        deadline: Math.floor(Date.now() / 1000) + 3600,
      },
      fees: [],
    };
  };

  const buildDeposit = (overrides?: { depositId?: Hex; amount?: string }) => ({
    data: { chainId: depositChainId, transactionId },
    result: {
      depositor,
      depository: "0x0987654321098765432109876543210987654321",
      currency: currencyLower,
      amount: overrides?.amount ?? amount,
      onchainId,
      depositId: overrides?.depositId ?? keccak256("0xdead" as Hex),
    },
    extraData: { timestamp: String(Math.floor(Date.now() / 1000)) },
  });

  const setupMockAttestor = (messages: ReturnType<typeof buildDeposit>[]) => {
    const mockAttestor: any = {
      getDepositoryDepositMessages: jest
        .fn<() => Promise<ReturnType<typeof buildDeposit>[]>>()
        .mockResolvedValue(messages),
    };
    mockGetVmAttestor.mockResolvedValue(mockAttestor);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: getEntry returns a non-zero createdAt so no-fill-or-refund
    // passes; tests can override.
    jest.mocked(getHubHttpRpc).mockResolvedValue({
      readContract: jest.fn<any>().mockResolvedValue(["0x01", 1000n]),
    } as any);
    jest.mocked(getBalanceOnHub).mockResolvedValue(10000n);
    jest.mocked(verifyMessage).mockResolvedValue(true);
  });

  const baseParams = {
    chainId,
    currency: currencyLower,
    amount,
    recipient: refundRecipientLower,
    owner: depositor,
    ownerChainId: depositChainId,
    depositChainId,
    depositTransactionId: transactionId,
    depositOnchainId: onchainId,
    orderSignature: "0x" + "00".repeat(65),
  };

  it("happy path — all invariants pass", async () => {
    const order = buildOrder();
    const orderId = getOrderId(order, await getSdkChainsConfig());
    setupMockAttestor([buildDeposit({ depositId: orderId })]);

    await expect(
      validateRecoverMode({
        attestationService: service,
        order,
        ...baseParams,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects when amount does not equal deposit amount (F-001)", async () => {
    const order = buildOrder();
    const orderId = getOrderId(order, await getSdkChainsConfig());
    setupMockAttestor([buildDeposit({ depositId: orderId, amount: "1000" })]);

    await expect(
      validateRecoverMode({
        attestationService: service,
        order,
        ...baseParams,
        amount: "999", // 1 wei short of deposit
      }),
    ).rejects.toThrow(/Amount does not match the deposit amount/);
  });

  it("accepts EVM checksum-cased recipient (F-005)", async () => {
    // Order has refund.recipient in lowercase canonical form.
    const order = buildOrder({ refundRecipient: refundRecipientLower });
    const orderId = getOrderId(order, await getSdkChainsConfig());
    setupMockAttestor([buildDeposit({ depositId: orderId })]);

    // Caller passes the same address in checksum (mixed-case) form.
    await expect(
      validateRecoverMode({
        attestationService: service,
        order,
        ...baseParams,
        recipient: refundRecipientChecksum,
      }),
    ).resolves.toBeUndefined();
  });

  it("matches currency when order is lowercase and caller passes checksum", async () => {
    const order = buildOrder({ refundCurrency: currencyLower });
    const orderId = getOrderId(order, await getSdkChainsConfig());
    setupMockAttestor([buildDeposit({ depositId: orderId })]);

    await expect(
      validateRecoverMode({
        attestationService: service,
        order,
        ...baseParams,
        currency: currencyChecksum,
      }),
    ).resolves.toBeUndefined();
  });

  it("matches currency when order is checksum and caller passes lowercase", async () => {
    const order = buildOrder({ refundCurrency: currencyChecksum });
    const orderId = getOrderId(order, await getSdkChainsConfig());
    setupMockAttestor([buildDeposit({ depositId: orderId })]);

    await expect(
      validateRecoverMode({
        attestationService: service,
        order,
        ...baseParams,
        currency: currencyLower,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects when currency does not match any refund entry", async () => {
    const order = buildOrder();
    const orderId = getOrderId(order, await getSdkChainsConfig());
    setupMockAttestor([buildDeposit({ depositId: orderId })]);

    await expect(
      validateRecoverMode({
        attestationService: service,
        order,
        ...baseParams,
        currency: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      }),
    ).rejects.toThrow(/Expected exactly 1 refund entry/);
  });

  // Cross-VM coverage: exercises the bs58 → bytes → hex path inside
  // `encodeAddress` to confirm the comparison works for non-EVM VMs.
  it("matches Solana base58 currency end-to-end (happy path)", async () => {
    const order = buildOrder({
      refundChainId: "solana",
      refundRecipient: solRecipient,
      refundCurrency: solUsdcMint,
    });
    const orderId = getOrderId(order, await getSdkChainsConfig());
    setupMockAttestor([buildDeposit({ depositId: orderId })]);

    await expect(
      validateRecoverMode({
        attestationService: service,
        order,
        ...baseParams,
        chainId: "solana",
        recipient: solRecipient,
        currency: solUsdcMint,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects when Solana currency is a different mint", async () => {
    const order = buildOrder({
      refundChainId: "solana",
      refundRecipient: solRecipient,
      refundCurrency: solUsdcMint,
    });
    const orderId = getOrderId(order, await getSdkChainsConfig());
    setupMockAttestor([buildDeposit({ depositId: orderId })]);

    await expect(
      validateRecoverMode({
        attestationService: service,
        order,
        ...baseParams,
        chainId: "solana",
        recipient: solRecipient,
        currency: solUsdtMint, // valid base58, but wrong mint
      }),
    ).rejects.toThrow(/Expected exactly 1 refund entry/);
  });

  it("rejects multi-input orders", async () => {
    const order = buildOrder({ inputCount: 2 });
    setupMockAttestor([buildDeposit()]);

    await expect(
      validateRecoverMode({
        attestationService: service,
        order,
        ...baseParams,
      }),
    ).rejects.toThrow(/single-input/);
  });

  it("rejects when any recoverMode field is missing", async () => {
    const order = buildOrder();
    setupMockAttestor([buildDeposit()]);

    const { depositTransactionId: _omit, ...partialParams } = baseParams;

    await expect(
      validateRecoverMode({
        attestationService: service,
        order,
        ...partialParams,
      } as any),
    ).rejects.toThrow(
      /recoverMode requires depositChainId, depositTransactionId/,
    );
  });
});

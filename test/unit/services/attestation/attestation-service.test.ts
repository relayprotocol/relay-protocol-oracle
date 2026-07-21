import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import {
  zeroHash,
  keccak256,
  encodePacked,
  Hex,
  verifyTypedData,
  verifyMessage,
  encodeAbiParameters,
} from "viem";

import { AttestationService } from "../../../../src/services/attestation";
import { getVmAttestor } from "../../../../src/services/attestation/vm";
import { getDeterministicId } from "../../../../src/services/attestation/utils";
import {
  ActionType,
  decodeAction,
  DepositoryWithdrawalStatus,
  encodeWithdrawal,
  decodeWithdrawal,
  getDecodedWithdrawalCurrency,
  getWithdrawalAddress,
  getOrderId,
  Order,
  generateTokenId,
  generateAddress,
  encodeAddress,
  getNoFillOrRefundMessage,
  getNonceMappingMessage,
  getWithdrawRequestHash,
  normalizeWithdrawRequest,
  SolverFillStatus,
  SolverRefundStatus,
  getDepositAddressTriggerHash,
} from "@relay-protocol/settlement-sdk";

import {
  Chain,
  getChainVmType,
  getSdkChainsConfig,
} from "../../../../src/common/chains";
import { createMockWithdrawalAddressRequest } from "../../../common/withdrawals";
import { getBalanceOnHub, getHubHttpRpc } from "../../../../src/common/hub";
import { getAddress } from "viem";

// default vars
const owner = "0x1234567890123456789012345678901234567890";
const ownerChainId = "ethereum";
const depositoryAddress = "0x0987654321098765432109876543210987654321";
const solanaDepositoryAddress = "FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u";

jest.mock("../../../../src/services/attestation/vm");
jest.mock("../../../../src/common/chains");
jest.mock("../../../../src/common/hub", () => ({
  getBalanceOnHub: jest.fn().mockImplementation(() => Promise.resolve(10000n)),
  getHubHttpRpc: jest.fn().mockImplementation(() =>
    Promise.resolve({
      readContract: jest.fn(),
      getBlock: jest.fn(),
    }),
  ),
}));

// Mock signature verification
jest.mock("viem", () => {
  const viem = jest.requireActual("viem") as typeof import("viem");
  return {
    ...viem,
    verifyMessage: jest.fn().mockImplementation(() => Promise.resolve(true)),
    verifyTypedData: jest.fn().mockImplementation(() => Promise.resolve(true)),
  };
});

jest.mock("../../../../src/common/chains", () => {
  const chains: Record<string, Chain> = {
    ethereum: {
      id: "ethereum",
      vmType: "ethereum-vm",
      httpRpcUrl: "http://127.0.0.1:8545",
      depository: "0x0987654321098765432109876543210987654321",
      hubChainId: "1",
      additionalData: {
        fastMode: {
          feeRecipient: "0x00000000000000000000000000000000000000fe",
          finalityTiers: {
            "0x1111111111111111111111111111111111111111": [
              {
                maxAmount: "2000",
                finalizationBlocks: 1,
                finalizationTime: 1,
                // 1% as a 1e18-scaled fraction (1e16)
                feeBps: "10000000000000000",
              },
            ],
          },
        },
      },
    },
    solana: {
      id: "solana",
      vmType: "solana-vm",
      httpRpcUrl: "http://127.0.0.1:8545",
      depository: "FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u",
      hubChainId:
        "50176979118388105370421134508366610418687875236156196470082648173271157915018",
    },
    hyperliquid: {
      id: "hyperliquid",
      vmType: "hyperliquid-vm",
      httpRpcUrl: "http://127.0.0.1:8545",
      depository: "0x0987654321098765432109876543210987654321",
      hubChainId: "1",
    },
    ton: {
      id: "ton",
      vmType: "ton-vm",
      httpRpcUrl: "http://127.0.0.1:8545",
      depository:
        "0:f37b9f6fd97ece249cb48d9aa5d0202570ad130b7b7d4ce4dd0f4cd551b3d9bd",
      hubChainId: "1",
    },
    lighter: {
      id: "lighter",
      vmType: "lighter-vm",
      httpRpcUrl: "http://127.0.0.1:8545",
      depository: "460491",
      additionalDepositories: ["460492"],
      hubChainId: "1",
    },
  };
  return {
    getChains: async () => chains,
    getChain: async (chainId: string) => chains[chainId],
    getChainVmType: jest.fn().mockImplementation(async (chainId) => {
      if (chainId === "ethereum") return "ethereum-vm";
      if (chainId === "solana") return "solana-vm";
      if (chainId === "hyperliquid-vm") return "hyperliquid-vm";
      if (chainId === "base") return "ethereum-vm";
      if (chainId === "relay") return "ethereum-vm";
      if (chainId === "ton") return "ton-vm";
      if (chainId === "lighter") return "lighter-vm";
      throw new Error(`Unknown chain: ${chainId}`);
    }),
    getChainHubChainId: jest.fn().mockImplementation(async (chainId) => {
      if (chainId === "ethereum") return 1;
      if (chainId === "solana") return 101;
      if (chainId === "hyperliquid-vm") return 1;
      if (chainId === "base") return 8543;
      if (chainId === "lighter") return 1;
      throw new Error(`Unknown chain: ${chainId}`);
    }),
    getHubInfo: jest.fn().mockImplementation(async () => ({
      id: "hub",
      evmChainId: "1",
      httpRpcUrl: "http://localhost:8545",
      hubAddress: "0x0000000000000000000000000000000000000001",
      oracleAddress: "0x0000000000000000000000000000000000000002",
      oracleMultisigAddress: "0x0000000000000000000000000000000000000003",
      genericMappingAddress: "0x0000000000000000000000000000000000000004",
      allocatorAddress: "0x0000000000000000000000000000000000000005",
      executorAddress: "0x0000000000000000000000000000000000000009",
      depositAddressManagerAddress:
        "0x0000000000000000000000000000000000000008",
      auroraHttpRpcUrl: "http://localhost:8545",
      auroraEvmChainId: "1313161554",
      auroraAllocatorAddress: "0x0000000000000000000000000000000000000005",
      auroraAllocatorSpenderAddress:
        "0x0000000000000000000000000000000000000006",
      auroraOracleMultisigAddress: "0x0000000000000000000000000000000000000007",
      rateLimiter: {
        address: "0x00000000000000000000000000000000000000aa",
        type: "amount",
      },
    })),
    RELAY_CHAIN_ID: "relay",
    getSdkChainsConfig: jest.fn(() => ({
      ethereum: "ethereum-vm",
      solana: "solana-vm",
    })),
  };
});

const mockGetVmAttestor = jest.mocked(getVmAttestor);

describe("AttestationService", () => {
  const service = new AttestationService();

  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks keeps implementations, so restore the default hub balance each test — otherwise a
    // per-test getBalanceOnHub override (fast settlement / recover cases) leaks into later tests.
    jest.mocked(getBalanceOnHub).mockResolvedValue(10000n);
  });

  describe("attestDepositoryDeposits", () => {
    it(`returns correct execution data with deposit id`, async () => {
      const requestBody = {
        chainId: "ethereum",
        transactionId:
          "0x552985b36c59902b24fde1437a11a2698347aa5ca2bf82697d0f8e8e1e35cc6e",
      };
      const mockMessages = [
        {
          data: {
            chainId: requestBody.chainId,
            transactionId: requestBody.transactionId,
          },
          result: {
            depositor: "0x1234567890123456789012345678901234567890",
            depository: "0x0987654321098765432109876543210987654321",
            currency: "0x1111111111111111111111111111111111111111",
            amount: "1000",
            onchainId:
              "0x0000000000000000000000000000000000000000000000000000000000000999", // bytes32
            depositId:
              "0x0000000000000000000000000000000000000000000000000000000000000789",
          },
          extraData: { timestamp: "1234567890" },
        },
      ];

      const mockAttestor: any = {
        getDepositoryDepositMessages: jest
          .fn()
          .mockImplementation(() => Promise.resolve(mockMessages)),
      };

      mockGetVmAttestor.mockResolvedValue(mockAttestor);

      const result = await service.attestDepositoryDeposits(requestBody);
      const [mockMessage] = mockMessages;
      const idempotencyKey = getDeterministicId(
        mockMessage.data.chainId,
        mockMessage.data.transactionId,
      );

      const hubTokenId = generateTokenId({
        address: mockMessage.result.currency,
        chainId: mockMessage.data.chainId,
        family: await getChainVmType(mockMessage.data.chainId),
      });

      const [action] = result.execution?.actions || [];
      expect(result.messages).toEqual(mockMessages);
      expect(result.execution).toBeDefined();
      expect(result.execution?.idempotencyKey).toBe(idempotencyKey);
      expect(result.execution?.actions.length).toBe(1);
      expect(decodeAction(action)).toEqual({
        type: ActionType.MINT,
        data: {
          hubTokenId,
          hubToAddress: "0x5dCC0A25a0170DB4D7A4E634b6D416d41717553a",
          amount: mockMessage.result.amount,
        },
      });
    });

    // Shared fast-deposit fixture: the VM returns a message already marked fast with a per-tier fee.
    const FAST_TX_ID =
      "0x552985b36c59902b24fde1437a11a2698347aa5ca2bf82697d0f8e8e1e35cc6e";
    const fastDepositResult = {
      depositor: "0x1234567890123456789012345678901234567890",
      depository: "0x0987654321098765432109876543210987654321",
      currency: "0x1111111111111111111111111111111111111111",
      amount: "1010", // gross = 1000 net + 10 fee at 1% (1e16 feeBps)
      onchainId:
        "0x0000000000000000000000000000000000000000000000000000000000000999",
      depositId:
        "0x0000000000000000000000000000000000000000000000000000000000000789",
    };
    const fastAttestorMock = () => ({
      getDepositoryDepositMessages: jest.fn().mockImplementation(() =>
        Promise.resolve([
          {
            data: { chainId: "ethereum", transactionId: FAST_TX_ID },
            result: fastDepositResult,
            extraData: {
              timestamp: "1234567890",
              mode: "fast",
              fastFeeBps: "10000000000000000",
            },
          },
        ]),
      ),
    });
    // Stub the hub read the fast pre-check makes (canConsume): within budget / over budget / read error.
    const mockCanConsume = (outcome: "ok" | "reject" | "error") => {
      const readContract = jest.fn<any>();
      if (outcome === "error") {
        readContract.mockRejectedValue(new Error("rpc down"));
      } else {
        readContract.mockResolvedValue(outcome === "ok");
      }
      jest.mocked(getHubHttpRpc).mockResolvedValue({
        readContract,
        getBlock: jest.fn(),
      } as any);
    };

    it(`emits FAST_MINT for a fast-applied deposit`, async () => {
      mockGetVmAttestor.mockResolvedValue(fastAttestorMock() as any);
      mockCanConsume("ok"); // within budget

      const result = await service.attestDepositoryDeposits({
        chainId: "ethereum",
        transactionId: FAST_TX_ID,
        mode: "fast",
      });

      expect(result.messages[0].extraData.mode).toBe("fast");
      expect(result.execution?.actions.length).toBe(1);
      const [action] = result.execution?.actions || [];
      const decoded = decodeAction(action) as any;
      expect(decoded.type).toBe(ActionType.FAST_MINT);
      expect(decoded.data.amount).toBe("1010");
      expect(decoded.data.hubTokenId).toBe(
        generateTokenId({
          address: fastDepositResult.currency,
          chainId: "ethereum",
          family: await getChainVmType("ethereum"),
        }),
      );
      expect(getAddress(decoded.data.rateLimiter)).toBe(
        getAddress("0x00000000000000000000000000000000000000aa"),
      );
      expect(decoded.data.rateLimiterData).toBe("0x");
      expect(getAddress(decoded.data.feeCalculator)).toBe(
        getAddress("0x0000000000000000000000000000000000000000"),
      );
      expect(decoded.data.feeCalculatorData).toBe("0x");
      expect(getAddress(decoded.data.hubToAddress)).toBe(
        getAddress("0x5dCC0A25a0170DB4D7A4E634b6D416d41717553a"),
      );
      // The attested amount stays gross (1010); the contract splits the fee on-chain — we don't rewrite it.
      expect(result.messages[0].result.amount).toBe("1010");
    });

    it(`throws (retry-slow) when the rate-limit pre-check rejects a fast deposit`, async () => {
      mockGetVmAttestor.mockResolvedValue(fastAttestorMock() as any);
      mockCanConsume("reject"); // bucket over budget → caller re-requests slow

      await expect(
        service.attestDepositoryDeposits({
          chainId: "ethereum",
          transactionId: FAST_TX_ID,
          mode: "fast",
        }),
      ).rejects.toThrow(/rate limit/i);
    });

    it(`fails open (still emits FAST_MINT) when the rate-limit pre-check read errors`, async () => {
      mockGetVmAttestor.mockResolvedValue(fastAttestorMock() as any);
      mockCanConsume("error"); // RPC blip → fail open

      const result = await service.attestDepositoryDeposits({
        chainId: "ethereum",
        transactionId: FAST_TX_ID,
        mode: "fast",
      });
      const [action] = result.execution?.actions || [];
      const decoded = decodeAction(action) as any;
      expect(decoded.type).toBe(ActionType.FAST_MINT);
    });

    it(`uses deposit chain to compute recipient address when depositId is zeroHash`, async () => {
      const requestBody = {
        chainId: "ethereum",
        transactionId:
          "0x552985b36c59902b24fde1437a11a2698347aa5ca2bf82697d0f8e8e1e35cc6e",
      };
      const depositor = "0x1234567890123456789012345678901234567890";
      const mockMessages = [
        {
          data: {
            chainId: requestBody.chainId,
            transactionId: requestBody.transactionId,
          },
          result: {
            depositor,
            depository: "0x0987654321098765432109876543210987654321",
            currency: "0x1111111111111111111111111111111111111111",
            amount: "1000",
            onchainId:
              "0x0000000000000000000000000000000000000000000000000000000000000999",
            depositId: zeroHash, // No deposit id attached
          },
          extraData: { timestamp: "1234567890" },
        },
      ];

      const mockAttestor: any = {
        getDepositoryDepositMessages: jest
          .fn()
          .mockImplementation(() => Promise.resolve(mockMessages)),
      };

      mockGetVmAttestor.mockResolvedValue(mockAttestor);

      const result = await service.attestDepositoryDeposits(requestBody);
      const [mockMessage] = mockMessages;
      const idempotencyKey = getDeterministicId(
        mockMessage.data.chainId,
        mockMessage.data.transactionId,
      );

      const hubTokenId = generateTokenId({
        address: mockMessage.result.currency,
        chainId: mockMessage.data.chainId,
        family: await getChainVmType(mockMessage.data.chainId),
      });

      const expectedHubToAddress = generateAddress({
        address: depositor,
        chainId: mockMessage.data.chainId,
        family: await getChainVmType(mockMessage.data.chainId),
      });

      const [action] = result.execution?.actions || [];
      expect(result.messages).toEqual(mockMessages);
      expect(result.execution).toBeDefined();
      expect(result.execution?.idempotencyKey).toBe(idempotencyKey);
      expect(result.execution?.actions.length).toBe(1);
      expect(decodeAction(action)).toEqual({
        type: ActionType.MINT,
        data: {
          hubTokenId,
          hubToAddress: expectedHubToAddress,
          amount: mockMessage.result.amount,
        },
      });
    });
  });

  describe("attestDepositoryWithdrawals", () => {
    const withdrawalAddressRequest = createMockWithdrawalAddressRequest({
      chainId: "ethereum",
      withdrawer: owner,
      withdrawerChainId: ownerChainId,
    });

    it(`returns correct execution data with withdrawal execution for ethereum-vm`, async () => {
      const recipient = "0xf70da97812cb96acdf810712aa562db8dfa3dbef";
      const amount = "1000";

      // the alias for withdrawer address on origin chain
      const withdrawerAlias = generateAddress({
        address: owner,
        chainId: ownerChainId,
        family: await getChainVmType(ownerChainId),
      });

      // Create a valid ethereum-vm withdrawal
      const decodedWithdrawal = {
        vmType: "ethereum-vm" as const,
        withdrawal: {
          calls: [
            {
              to: recipient,
              data: "0x",
              value: amount,
              allowFailure: false,
            },
          ],
          nonce: "0",
          expiration: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
        },
      };

      const withdrawal = encodeWithdrawal(decodedWithdrawal);

      // Decode the withdrawal to get the actual currency
      const actualDecodedWithdrawal = decodeWithdrawal(
        withdrawal,
        "ethereum-vm",
      );
      const actualCurrency = getDecodedWithdrawalCurrency(
        actualDecodedWithdrawal,
      );

      // Update withdrawalAddressRequest with the actual currency
      const withdrawalAddressRequestWithCurrency = {
        ...withdrawalAddressRequest,
        currency: actualCurrency,
        withdrawerAlias,
      };

      const requestBody = {
        chainId: "ethereum",
        withdrawal,
        expectedAmount: amount,
        transactionId:
          "0x552985b36c59902b24fde1437a11a2698347aa5ca2bf82697d0f8e8e1e35cc6e",
        withdrawalAddressRequest: withdrawalAddressRequestWithCurrency,
      };

      const withdrawalId =
        "0x0000000000000000000000000000000000000000000000000000000000000999";
      const mockMessage = {
        data: {
          chainId: requestBody.chainId,
          withdrawal: requestBody.withdrawal,
        },
        result: {
          withdrawalId,
          depository: "0x0987654321098765432109876543210987654321",
          status: DepositoryWithdrawalStatus.EXECUTED,
        },
      };

      const mockAttestor: any = {
        getDepositoryWithdrawalMessage: jest
          .fn()
          .mockImplementation(() => Promise.resolve(mockMessage)),
      };

      mockGetVmAttestor.mockResolvedValue(mockAttestor);

      const withdrawalAddress = getWithdrawalAddress({
        depository: depositoryAddress!,
        chainId: "ethereum",
        vmType: "ethereum-vm",
        currency: withdrawalAddressRequestWithCurrency.currency,
        ownerAlias: withdrawalAddressRequestWithCurrency.withdrawerAlias,
        recipient: withdrawalAddressRequest.recipient,
        nonce: withdrawalAddressRequestWithCurrency.withdrawalNonce,
      });

      const result = await service.attestDepositoryWithdrawal(requestBody);
      const idempotencyKey = getDeterministicId(
        mockMessage.result.withdrawalId,
        requestBody.transactionId!,
      );

      const hubTokenId = generateTokenId({
        address: actualCurrency,
        chainId: requestBody.chainId,
        family: await getChainVmType(requestBody.chainId),
      });

      const [action] = result.execution?.actions || [];
      expect(result.message).toEqual(mockMessage);
      expect(result.execution).toBeDefined();
      expect(result.execution?.idempotencyKey).toBe(idempotencyKey);
      expect(result.execution?.actions.length).toBe(1);
      expect(decodeAction(action)).toEqual({
        type: ActionType.BURN,
        data: {
          hubTokenId,
          hubFromAddress: getAddress(withdrawalAddress),
          amount,
        },
      });
    });

    it(`returns correct execution data with expired withdrawal execution for ethereum-vm`, async () => {
      const recipient = "0xf70da97812cb96acdf810712aa562db8dfa3dbef";
      const amount = "1000";

      // the alias for the depositor
      const withdrawerAlias = generateAddress({
        address: owner,
        chainId: ownerChainId,
        family: await getChainVmType(ownerChainId),
      });

      // Create an expired ethereum-vm withdrawal
      const decodedWithdrawal = {
        vmType: "ethereum-vm" as const,
        withdrawal: {
          calls: [
            {
              to: recipient,
              data: "0x",
              value: amount,
              allowFailure: false,
            },
          ],
          nonce: "0",
          expiration: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago (expired)
        },
      };

      const withdrawal = encodeWithdrawal(decodedWithdrawal);

      // Decode the withdrawal to get the actual currency
      const actualDecodedWithdrawal = decodeWithdrawal(
        withdrawal,
        "ethereum-vm",
      );
      const actualCurrency = getDecodedWithdrawalCurrency(
        actualDecodedWithdrawal,
      );

      // Update withdrawalAddressRequest with the actual currency
      const withdrawalAddressRequestWithCurrency = {
        ...withdrawalAddressRequest,
        currency: actualCurrency,
        withdrawerAlias,
      };

      const requestBody = {
        chainId: "ethereum",
        withdrawal,
        transactionId:
          "0x552985b36c59902b24fde1437a11a2698347aa5ca2bf82697d0f8e8e1e35cc6e",
        withdrawalAddressRequest: withdrawalAddressRequestWithCurrency,
      };

      const withdrawalId =
        "0x0000000000000000000000000000000000000000000000000000000000000999";
      const mockMessage = {
        data: {
          chainId: requestBody.chainId,
          withdrawal: requestBody.withdrawal,
        },
        result: {
          withdrawalId,
          depository: "0x0987654321098765432109876543210987654321",
          status: DepositoryWithdrawalStatus.EXPIRED,
        },
      };

      const mockAttestor: any = {
        getDepositoryWithdrawalMessage: jest
          .fn()
          .mockImplementation(() => Promise.resolve(mockMessage)),
      };

      mockGetVmAttestor.mockResolvedValue(mockAttestor);

      const withdrawalAddress = getWithdrawalAddress({
        depository: depositoryAddress!,
        chainId: "ethereum",
        vmType: "ethereum-vm",
        currency: withdrawalAddressRequestWithCurrency.currency,
        ownerAlias: withdrawalAddressRequestWithCurrency.withdrawerAlias,
        recipient: withdrawalAddressRequest.recipient,
        nonce: withdrawalAddressRequestWithCurrency.withdrawalNonce,
      });

      const result = await service.attestDepositoryWithdrawal(requestBody);
      const idempotencyKey = getDeterministicId(
        mockMessage.result.withdrawalId,
        requestBody.transactionId!,
        DepositoryWithdrawalStatus.EXPIRED.toString(),
      );

      const hubTokenId = generateTokenId({
        address: actualCurrency,
        chainId: requestBody.chainId,
        family: await getChainVmType(requestBody.chainId),
      });

      const [action] = result.execution?.actions || [];
      expect(result.message).toEqual(mockMessage);
      expect(result.execution).toBeDefined();
      expect(result.execution?.idempotencyKey).toBe(idempotencyKey);
      expect(result.execution?.actions.length).toBe(1);
      expect(decodeAction(action)).toEqual({
        type: ActionType.TRANSFER,
        data: {
          hubTokenId,
          hubFromAddress: getAddress(withdrawalAddress),
          hubToAddress: withdrawerAlias,
          amount,
        },
      });
    });

    it(`returns correct execution data with withdrawal execution for solana-vm`, async () => {
      const currency = "11111111111111111111111111111111"; // Native SOL
      const recipient = "7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ";
      const amount = "1000000000"; // 1 SOL in lamports

      // Create a valid solana-vm withdrawal
      const decodedWithdrawal = {
        vmType: "solana-vm" as const,
        withdrawal: {
          domain: zeroHash,
          recipient,
          token: currency,
          amount,
          nonce: "0",
          expiration: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
          vaultAddress: currency,
        },
      };

      const withdrawal = encodeWithdrawal(decodedWithdrawal);

      // Get the actual currency from the withdrawal
      const actualDecodedWithdrawal = decodeWithdrawal(withdrawal, "solana-vm");
      const actualCurrency = getDecodedWithdrawalCurrency(
        actualDecodedWithdrawal,
      );

      const solanaWithdrawalAddressRequest = createMockWithdrawalAddressRequest(
        {
          chainId: "solana",
          currency: actualCurrency,
          withdrawer: owner,
          withdrawerChainId: ownerChainId,
          recipient: actualCurrency,
        },
      );

      const requestBody = {
        chainId: "solana",
        withdrawal,
        transactionId:
          "5j7s8K9j2k3l4m5n6o7p8q9r0s1t2u3v4w5x6y7z8a9b0c1d2e3f4g5h6i7j8k9l0m1n2o3p4",
        withdrawalAddressRequest: solanaWithdrawalAddressRequest,
      };

      const withdrawalId =
        "0x0000000000000000000000000000000000000000000000000000000000000999";
      const mockMessage = {
        data: {
          chainId: requestBody.chainId,
          withdrawal: requestBody.withdrawal,
        },
        result: {
          withdrawalId,
          depository: "7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ", // Solana base58 address for the mock message
          status: DepositoryWithdrawalStatus.EXECUTED,
        },
      };

      const ownerAlias = generateAddress({
        address: owner,
        chainId: ownerChainId,
        family: await getChainVmType(ownerChainId),
      });

      const withdrawalAddress = getWithdrawalAddress({
        depository: solanaDepositoryAddress,
        chainId: "solana",
        vmType: "solana-vm",
        currency: solanaWithdrawalAddressRequest.currency,
        ownerAlias,
        recipient: solanaWithdrawalAddressRequest.recipient,
        nonce: solanaWithdrawalAddressRequest.withdrawalNonce,
      });

      const mockAttestor: any = {
        getDepositoryWithdrawalMessage: jest
          .fn()
          .mockImplementation(() => Promise.resolve(mockMessage)),
      };

      mockGetVmAttestor.mockResolvedValue(mockAttestor);

      const result = await service.attestDepositoryWithdrawal(requestBody);
      const idempotencyKey = getDeterministicId(
        mockMessage.result.withdrawalId,
        requestBody.transactionId!,
      );

      const hubTokenId = generateTokenId({
        address: actualCurrency,
        chainId: requestBody.chainId,
        family: await getChainVmType(requestBody.chainId),
      });

      const [action] = result.execution?.actions || [];
      expect(result.message).toEqual(mockMessage);
      expect(result.execution).toBeDefined();
      expect(result.execution?.idempotencyKey).toBe(idempotencyKey);
      expect(result.execution?.actions.length).toBe(1);
      expect(decodeAction(action)).toEqual({
        type: ActionType.BURN,
        data: {
          hubTokenId,
          hubFromAddress: getAddress(withdrawalAddress),
          amount,
        },
      });
    });
  });

  describe("attestDepositoryWithdrawalV3", () => {
    // Native TON spender + native sentinel currency (spenderChainId is non-EVM).
    const tonWithdrawRequest = {
      chainId: "ton",
      depository:
        "0:f37b9f6fd97ece249cb48d9aa5d0202570ad130b7b7d4ce4dd0f4cd551b3d9bd",
      currency: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
      amount: "1000",
      spenderChainId: "ton",
      spender:
        "0:5fcddb24292ed63ce6fce30e4f952c248550ae8d524e5d7b558b437d31241156",
      receiver:
        "0:5fcddb24292ed63ce6fce30e4f952c248550ae8d524e5d7b558b437d31241156",
      nonce:
        "0x0000000000000000000000000000000000000000000000000000000000000001",
    };

    it("mints an expired ton-vm withdrawal back to the native spender alias", async () => {
      // _getEncodedWithdrawalV3 reads: payloadBuilders -> family() -> payloads
      const mockedHubRpc = {
        readContract: jest
          .fn<any>()
          .mockResolvedValueOnce("0x1E501Cb130fac80b3CaD5145AbCbF7393B02C3a5")
          .mockResolvedValueOnce("ton-vm")
          .mockResolvedValueOnce("0xdeadbeef"),
      };
      jest.mocked(getHubHttpRpc).mockResolvedValue(mockedHubRpc as any);

      const mockAttestor: any = {
        getDepositoryWithdrawalMessage: jest.fn().mockImplementation(() =>
          Promise.resolve({
            data: {
              chainId: tonWithdrawRequest.chainId,
              withdrawal: "0xdeadbeef",
            },
            result: {
              withdrawalId: zeroHash,
              depository: tonWithdrawRequest.depository,
              status: DepositoryWithdrawalStatus.EXPIRED,
            },
          }),
        ),
      };
      mockGetVmAttestor.mockResolvedValue(mockAttestor);

      const result =
        await service.attestDepositoryWithdrawalV3(tonWithdrawRequest);

      expect(result.status).toBe(DepositoryWithdrawalStatus.EXPIRED);
      const [action] = result.execution?.actions || [];
      // Regression guard for DEC-1086: the mint-back must derive tokenId/alias
      // from the denormalized (native) currency/spender. Feeding the normalized
      // 0x-hex throws in encodeAddress (Address.parse) for ton.
      expect(decodeAction(action)).toEqual({
        type: ActionType.MINT,
        data: {
          hubTokenId: generateTokenId({
            address: tonWithdrawRequest.currency,
            chainId: tonWithdrawRequest.chainId,
            family: "ton-vm",
          }),
          hubToAddress: getAddress(
            generateAddress({
              address: tonWithdrawRequest.spender,
              chainId: tonWithdrawRequest.spenderChainId,
              family: "ton-vm",
            }),
          ),
          amount: tonWithdrawRequest.amount,
        },
      });
    });

    it("accepts an equivalent user-friendly TON depository address", async () => {
      const mockedHubRpc = {
        readContract: jest
          .fn<any>()
          .mockResolvedValueOnce("0x1E501Cb130fac80b3CaD5145AbCbF7393B02C3a5")
          .mockResolvedValueOnce("ton-vm")
          .mockResolvedValueOnce("0xdeadbeef"),
      };
      jest.mocked(getHubHttpRpc).mockResolvedValue(mockedHubRpc as any);

      const mockAttestor: any = {
        getDepositoryWithdrawalMessage: jest.fn().mockImplementation(() =>
          Promise.resolve({
            data: {
              chainId: tonWithdrawRequest.chainId,
              withdrawal: "0xdeadbeef",
            },
            result: {
              withdrawalId: zeroHash,
              depository: tonWithdrawRequest.depository,
              status: DepositoryWithdrawalStatus.PENDING,
            },
          }),
        ),
      };
      mockGetVmAttestor.mockResolvedValue(mockAttestor);

      const result = await service.attestDepositoryWithdrawalV3({
        ...tonWithdrawRequest,
        depository: "EQDze59v2X7OJJy0jZql0CAlcK0TC3t9TOTdD0zVUbPZvWjo",
      });

      expect(result.status).toBe(DepositoryWithdrawalStatus.PENDING);
      expect(result.execution).toBeUndefined();
    });

    it("attests a lighter-vm v3 withdrawal from an additional depository", async () => {
      const payload = encodeWithdrawal({
        vmType: "lighter-vm",
        withdrawal: {
          actionType: 0,
          parameters: {
            type: "Transfer",
            nonce: "123",
            fromAccountIndex: "460492",
            fromRouteType: "0",
            apiKeyIndex: "5",
            toAccountIndex: "99",
            toRouteType: "0",
            assetIndex: "3",
            amount: "1000",
            usdcFee: "10",
            lighterChainId: "304",
            memo: zeroHash.slice(2),
          },
        },
      });
      const mockedHubRpc = {
        readContract: jest
          .fn<any>()
          .mockResolvedValueOnce("0x1E501Cb130fac80b3CaD5145AbCbF7393B02C3a5")
          .mockResolvedValueOnce("lighter-vm")
          .mockResolvedValueOnce(payload),
      };
      jest.mocked(getHubHttpRpc).mockResolvedValue(mockedHubRpc as any);

      const mockAttestor: any = {
        getDepositoryWithdrawalMessage: jest.fn().mockImplementation(() =>
          Promise.resolve({
            data: {
              chainId: "lighter",
              withdrawal: payload,
            },
            result: {
              withdrawalId: zeroHash,
              depository: "460492",
              status: DepositoryWithdrawalStatus.EXECUTED,
            },
          }),
        ),
      };
      mockGetVmAttestor.mockResolvedValue(mockAttestor);

      const result = await service.attestDepositoryWithdrawalV3({
        chainId: "lighter",
        depository: "460492",
        currency: "3",
        amount: "1000",
        spenderChainId: "ethereum",
        spender: owner,
        receiver: "99",
        nonce: zeroHash,
        additionalData: {
          "lighter-vm": {
            nonce: "123",
            apiKeyIndex: "5",
            usdcFee: "10",
          },
        },
      });

      expect(result.status).toBe(DepositoryWithdrawalStatus.EXECUTED);
      expect(result.execution).toBeUndefined();
      expect(mockAttestor.getDepositoryWithdrawalMessage).toHaveBeenCalledWith(
        "lighter",
        payload,
        undefined,
        undefined,
      );
    });
  });

  describe("attestNonceMappingSignature", () => {
    const wallet = "0x1234567890123456789012345678901234567890";
    const depositor = "0x2234567890123456789012345678901234567890";
    const nonce = "1";
    const id = keccak256("0x1234" as Hex);
    const signatureChainId = "ethereum";
    const walletChainId = "hyperliquid";
    const mockSignature = "0x" + "ab".repeat(65);

    it("returns a generic mapping that includes the depositor", async () => {
      const result = await service.attestNonceMappingSignature({
        walletChainId,
        wallet,
        depositor,
        nonce,
        id,
        signatureChainId,
        signature: mockSignature,
      });

      const expectedUser = generateAddress({
        family: "hyperliquid-vm",
        chainId: "hyperliquid",
        address: wallet,
      });

      expect(result.genericMapping).toEqual(
        getNonceMappingMessage(expectedUser, nonce, id, depositor),
      );
      expect(result.genericMapping.user).toBe(expectedUser);
      expect(result.genericMapping.data).toBe(
        `${id}${depositor ? depositor.slice(2) : ""}`,
      );
      expect(result.genericMapping).not.toEqual(
        getNonceMappingMessage(expectedUser, nonce, id),
      );
    });

    it("verifies the typed data signature against the wallet", async () => {
      const mockedVerifyTypedData = jest.mocked(verifyTypedData);

      await service.attestNonceMappingSignature({
        walletChainId,
        wallet,
        depositor,
        nonce,
        id,
        signatureChainId,
        signature: mockSignature,
      });

      expect(mockedVerifyTypedData).toHaveBeenCalledWith({
        address: wallet,
        domain: {
          name: "RelayNonceMapping",
          version: "2",
          chainId: 1,
          verifyingContract: "0x0000000000000000000000000000000000000000",
        },
        types: {
          NonceMapping: [
            { name: "chainId", type: "string" },
            { name: "wallet", type: "address" },
            { name: "depositor", type: "address" },
            { name: "id", type: "bytes32" },
            { name: "nonce", type: "uint256" },
          ],
        },
        primaryType: "NonceMapping",
        message: {
          chainId: walletChainId,
          wallet,
          depositor,
          id,
          nonce: BigInt(nonce),
        },
        signature: mockSignature,
      });
    });

    it("throws on invalid wallet signature", async () => {
      const mockedVerifyTypedData = jest.mocked(verifyTypedData);
      mockedVerifyTypedData.mockResolvedValueOnce(false);

      await expect(
        service.attestNonceMappingSignature({
          walletChainId,
          wallet,
          depositor,
          nonce,
          id,
          signatureChainId,
          signature: mockSignature,
        }),
      ).rejects.toThrow("Invalid signature");
    });

    it("throws on unsupported signature chain", async () => {
      await expect(
        service.attestNonceMappingSignature({
          walletChainId,
          wallet,
          depositor,
          nonce,
          id,
          signatureChainId: "solana",
          signature: mockSignature,
        }),
      ).rejects.toThrow("Unsupported signature chain");
    });

    it("throws when the depositor signed instead of the wallet", async () => {
      const mockedVerifyTypedData = jest.mocked(verifyTypedData);
      // Simulate signature recovered to `depositor`, not `wallet`: verification
      // only succeeds when the address being verified matches `depositor`.
      mockedVerifyTypedData.mockImplementationOnce(
        async ({ address }) => address === depositor,
      );

      await expect(
        service.attestNonceMappingSignature({
          walletChainId,
          wallet,
          depositor,
          nonce,
          id,
          signatureChainId,
          signature: mockSignature,
        }),
      ).rejects.toThrow("Invalid signature");
    });
  });

  describe("attestNoFillOrRefundSignature", () => {
    const solver = "0x1234567890123456789012345678901234567890";
    const orderId = keccak256("0x5678" as Hex);
    const solverChainId = "ethereum";
    const mockSignature = "0x" + "ab".repeat(65);

    it("returns correct generic mapping for valid signature", async () => {
      const result = await service.attestNoFillOrRefundSignature({
        solverChainId,
        solver,
        orderId,
        signature: mockSignature,
      });

      const expectedSolver = generateAddress({
        family: "ethereum-vm",
        chainId: "ethereum",
        address: solver,
      });

      const expectedGenericMapping = getNoFillOrRefundMessage(
        expectedSolver,
        orderId,
      );

      expect(result.genericMapping).toEqual(expectedGenericMapping);
      expect(result.genericMapping.user).toBe(expectedSolver);
      expect(result.genericMapping.data).toBe("0x01");
    });

    it("verifies the typed data signature with correct parameters", async () => {
      const mockedVerifyTypedData = jest.mocked(verifyTypedData);

      await service.attestNoFillOrRefundSignature({
        solverChainId,
        solver,
        orderId,
        signature: mockSignature,
      });

      expect(mockedVerifyTypedData).toHaveBeenCalledWith({
        address: solver,
        domain: {
          name: "RelayNoFillOrRefund",
          version: "1",
          chainId: 1, // hubChainId for "ethereum"
          verifyingContract: "0x0000000000000000000000000000000000000000",
        },
        types: {
          NoFillOrRefund: [
            { name: "chainId", type: "string" },
            { name: "solver", type: "address" },
            { name: "orderId", type: "bytes32" },
          ],
        },
        primaryType: "NoFillOrRefund",
        message: {
          chainId: solverChainId,
          solver,
          orderId,
        },
        signature: mockSignature,
      });
    });

    it("throws on invalid signature", async () => {
      const mockedVerifyTypedData = jest.mocked(verifyTypedData);
      mockedVerifyTypedData.mockResolvedValueOnce(false);

      await expect(
        service.attestNoFillOrRefundSignature({
          solverChainId,
          solver,
          orderId,
          signature: mockSignature,
        }),
      ).rejects.toThrow("Invalid signature");
    });

    it("throws on unsupported signature chain", async () => {
      await expect(
        service.attestNoFillOrRefundSignature({
          solverChainId: "solana",
          solver,
          orderId,
          signature: mockSignature,
        }),
      ).rejects.toThrow("Unsupported signature chain");
    });
  });

  describe("attestDepositoryWithdrawalV3", () => {
    const withdrawRequestInput = {
      chainId: "ethereum",
      depository: depositoryAddress,
      currency: "0x1111111111111111111111111111111111111111",
      amount: "1000",
      spenderChainId: "relay",
      spender: "0x0000000000000000000000000000000000000009",
      receiver: "0xf70da97812cb96acdf810712aa562db8dfa3dbef",
      nonce:
        "0x0000000000000000000000000000000000000000000000000000000000000001",
    };

    it("mints expired swap-verifier withdrawals back to the recorded order address", async () => {
      const orderAddress = "0x0000000000000000000000000000000000000010";
      const mockedHubRpc = {
        readContract: jest
          .fn<any>()
          .mockResolvedValueOnce("0x0000000000000000000000000000000000000011")
          .mockResolvedValueOnce("ethereum-vm")
          .mockResolvedValueOnce("0x1234")
          .mockResolvedValueOnce(orderAddress),
      };
      jest.mocked(getHubHttpRpc).mockResolvedValue(mockedHubRpc as any);

      const mockAttestor: any = {
        getDepositoryWithdrawalMessage: jest.fn().mockImplementation(() =>
          Promise.resolve({
            data: {
              chainId: withdrawRequestInput.chainId,
              withdrawal: "0x1234",
            },
            result: {
              withdrawalId: zeroHash,
              depository: depositoryAddress,
              status: DepositoryWithdrawalStatus.EXPIRED,
            },
          }),
        ),
      };
      mockGetVmAttestor.mockResolvedValue(mockAttestor);

      const result =
        await service.attestDepositoryWithdrawalV3(withdrawRequestInput);

      const [action] = result.execution?.actions || [];
      expect(decodeAction(action)).toEqual({
        type: ActionType.MINT,
        data: {
          hubTokenId: generateTokenId({
            address: withdrawRequestInput.currency,
            chainId: withdrawRequestInput.chainId,
            family: "ethereum-vm",
          }),
          hubToAddress: orderAddress,
          amount: withdrawRequestInput.amount,
        },
      });
      expect(mockedHubRpc.readContract).toHaveBeenLastCalledWith(
        expect.objectContaining({
          functionName: "orderAddressByWithdrawRequestHash",
        }),
      );
    });
  });

  describe("attestWithdrawRequest", () => {
    const withdrawRequestInput = {
      chainId: "ethereum",
      depository: depositoryAddress,
      currency: "0x1111111111111111111111111111111111111111",
      amount: "1000",
      spenderChainId: "ethereum",
      spender: owner,
      receiver: "0xf70da97812cb96acdf810712aa562db8dfa3dbef",
      nonce:
        "0x0000000000000000000000000000000000000000000000000000000000000001",
      hashIndexes: [0, 1],
    };

    it("returns requested hashesToSign when all requested hashes are set", async () => {
      const hashesToSign = [
        "0x1111111111111111111111111111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      ];
      const mockedHubRpc = {
        readContract: jest
          .fn<any>()
          .mockResolvedValueOnce(hashesToSign[0])
          .mockResolvedValueOnce(hashesToSign[1]),
      };
      jest.mocked(getHubHttpRpc).mockResolvedValueOnce(mockedHubRpc as any);

      const result = await service.attestWithdrawRequest(withdrawRequestInput);

      const withdrawRequest = normalizeWithdrawRequest({
        ...withdrawRequestInput,
        vmType: "ethereum-vm",
        spenderVmType: "ethereum-vm",
      });
      const withdrawRequestHash = getWithdrawRequestHash(withdrawRequest);

      expect(result).toEqual({
        chainId: 1,
        allocator: "0x0000000000000000000000000000000000000005",
        withdrawRequestHash,
        hashesToSign,
      });
    });

    it("throws when any requested hashToSign is unset", async () => {
      const mockedHubRpc = {
        readContract: jest.fn<any>().mockResolvedValueOnce(zeroHash),
      };
      jest.mocked(getHubHttpRpc).mockResolvedValueOnce(mockedHubRpc as any);

      await expect(
        service.attestWithdrawRequest(withdrawRequestInput),
      ).rejects.toThrow("Hash to sign not set for withdraw request at index 0");
    });
  });

  describe("attestDepositAddressTrigger", () => {
    const triggerInput = {
      input: {
        vmType: "ethereum-vm",
        chainId: "ethereum",
        currency: "0x1111111111111111111111111111111111111111",
        amount: "1000",
      },
      derivationFields: {
        inputVmType: "ethereum-vm",
        outputVmType: "ethereum-vm",
        outputChainId: "ethereum",
        outputCurrency: "0x3333333333333333333333333333333333333333",
        outputRecipient: "0x2222222222222222222222222222222222222222",
        solver: "0x1234567890123456789012345678901234567890",
        pricingOracle: "0x4444444444444444444444444444444444444444",
        depositor: "0x5555555555555555555555555555555555555555",
        refundRecipient: "0x6666666666666666666666666666666666666666",
        priceImpactBps: "50",
      },
      orderId:
        "0x1234567890123456789012345678901234567890123456789012345678901234",
      nonce: "7",
      currencies: [
        {
          chainId: "ethereum",
          currency: "0x1111111111111111111111111111111111111111",
        },
        {
          chainId: "ethereum",
          currency: "0x3333333333333333333333333333333333333333",
        },
      ],
      prices: [
        {
          usdPrice: "123456",
          usdPriceDecimals: 8,
          currencyDecimals: 18,
          expiration: "2000000000",
        },
        {
          usdPrice: "789012",
          usdPriceDecimals: 8,
          currencyDecimals: 6,
          expiration: "2000000000",
        },
      ],
      extraData: "0x1234",
    };

    it("returns the SDK trigger hash after verifying it maps to the provided order id on-chain", async () => {
      const expectedTriggerHash = getDepositAddressTriggerHash(triggerInput);
      const mockedHubRpc = {
        readContract: jest
          .fn<any>()
          .mockResolvedValueOnce(triggerInput.orderId),
      };
      jest.mocked(getHubHttpRpc).mockResolvedValueOnce(mockedHubRpc as any);

      const result = await service.attestDepositAddressTrigger(triggerInput);

      expect(result).toEqual({
        chainId: "1",
        depositAddressManager: "0x0000000000000000000000000000000000000008",
        inputDepository: depositoryAddress,
        triggerHash: expectedTriggerHash,
      });
      expect(mockedHubRpc.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: "0x0000000000000000000000000000000000000008",
          functionName: "triggers",
          args: [expectedTriggerHash],
        }),
      );
    });

    it("throws when the on-chain trigger hash does not map to the provided order id", async () => {
      const mockedHubRpc = {
        readContract: jest.fn<any>().mockResolvedValueOnce(zeroHash),
      };
      jest.mocked(getHubHttpRpc).mockResolvedValueOnce(mockedHubRpc as any);

      await expect(
        service.attestDepositAddressTrigger(triggerInput),
      ).rejects.toThrow("Trigger hash does not map to the provided order id");
    });
  });

  describe("attestWithdrawAndFill", () => {
    const buildWithdrawAndFillFixture = async (overrides?: {
      multipleOutputs?: boolean;
      withFees?: boolean;
      wrongFeeCurrency?: boolean;
    }) => {
      const solverAddress = "0x1234567890123456789012345678901234567890";
      const depositor = "0x0987654321098765432109876543210987654321";
      const currency = "0x1111111111111111111111111111111111111111";
      const outputRecipient = "0x3333333333333333333333333333333333333333";
      const amount = "1000";
      const timestamp = "1234567890";
      const transactionId =
        "0x552985b36c59902b24fde1437a11a2698347aa5ca2bf82697d0f8e8e1e35cc6e";
      const onchainId =
        "0x0000000000000000000000000000000000000000000000000000000000000999";

      const order: Order = {
        version: "v1",
        salt: "0x1",
        solverChainId: "ethereum",
        solver: solverAddress,
        inputs: [
          {
            payment: {
              chainId: "ethereum",
              currency,
              amount,
              weight: "1",
            },
            refunds: [
              {
                chainId: "ethereum",
                recipient: outputRecipient,
                currency,
                minimumAmount: amount,
                deadline: Math.floor(Date.now() / 1000) + 3600,
                extraData: "0x",
              },
            ],
          },
        ],
        output: {
          chainId: "ethereum",
          payments: [
            {
              recipient: outputRecipient,
              currency,
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
      if (overrides?.multipleOutputs) {
        order.output.payments.push({
          recipient: "0x5555555555555555555555555555555555555555",
          currency,
          minimumAmount: amount,
          expectedAmount: amount,
        });
      }
      if (overrides?.withFees) {
        order.fees.push({
          recipientChainId: "ethereum",
          recipient: "0x5555555555555555555555555555555555555555",
          currencyChainId: "ethereum",
          currency,
          amount: "1",
        });
      }
      if (overrides?.wrongFeeCurrency) {
        order.fees.push({
          recipientChainId: "ethereum",
          recipient: "0x5555555555555555555555555555555555555555",
          currencyChainId: "ethereum",
          currency: "0x9999999999999999999999999999999999999999",
          amount: "1",
        });
      }

      const orderId = getOrderId(order, await getSdkChainsConfig());
      const mockDepositMessage = {
        data: {
          chainId: "ethereum",
          transactionId,
        },
        result: {
          depositor,
          depository: "0x4444444444444444444444444444444444444444",
          currency,
          amount,
          onchainId,
          depositId: orderId,
        },
        extraData: { timestamp },
      };

      const mockAttestor: any = {
        getDepositoryDepositMessages: jest
          .fn()
          .mockImplementation(() => Promise.resolve([mockDepositMessage])),
      };
      mockGetVmAttestor.mockResolvedValue(mockAttestor);

      return {
        order,
        orderId,
        mockDepositMessage,
        transactionId,
        onchainId,
        amount,
        currency,
        outputRecipient,
        depositor,
        timestamp,
      };
    };

    it("returns deposit execution and swap-and-withdraw request", async () => {
      const fixture = await buildWithdrawAndFillFixture();
      const nonce = "explicit-nonce";

      const result = await service.attestWithdrawAndFill({
        chainId: "ethereum",
        transactionId: fixture.transactionId,
        onchainId: fixture.onchainId,
        order: fixture.order,
        orderSignature: "0x" + "00".repeat(65),
        nonce,
      });

      expect(result.execution).toBeDefined();
      expect(result.execution.idempotencyKey).toBe(
        getDeterministicId("ethereum", fixture.transactionId),
      );
      expect(result.execution.actions).toHaveLength(1);

      const orderHash = keccak256(
        encodePacked(
          ["string", "bytes", "uint256", "bytes32"],
          [
            "ethereum",
            `0x${Buffer.from(
              encodeAddress(fixture.depositor, "ethereum-vm"),
            ).toString("hex")}`,
            BigInt(fixture.timestamp),
            fixture.orderId as Hex,
          ],
        ),
      );
      const expectedOrderAddress = `0x${orderHash
        .slice(2)
        .slice(-40)}` as `0x${string}`;

      expect(result.executeAndWithdrawRequest).toEqual({
        inChainId: "ethereum",
        inCurrency: `0x${Buffer.from(
          encodeAddress(fixture.currency, "ethereum-vm"),
        ).toString("hex")}`,
        outChainId: "ethereum",
        outCurrency: `0x${Buffer.from(
          encodeAddress(fixture.currency, "ethereum-vm"),
        ).toString("hex")}`,
        outAmountMinimum: fixture.amount,
        depository: `0x${Buffer.from(
          encodeAddress(depositoryAddress, "ethereum-vm"),
        ).toString("hex")}`,
        orderAddress: expectedOrderAddress,
        receiver: `0x${Buffer.from(
          encodeAddress(fixture.outputRecipient, "ethereum-vm"),
        ).toString("hex")}`,
        data: "0x",
        fees: [],
        nonce,
        deadline: fixture.order.output.deadline.toString(),
      });
      expect(verifyMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          address: fixture.order.solver,
          message: { raw: fixture.orderId },
        }),
      );
    });

    it("rejects orders with multiple outputs", async () => {
      const fixture = await buildWithdrawAndFillFixture({
        multipleOutputs: true,
      });

      await expect(
        service.attestWithdrawAndFill({
          chainId: "ethereum",
          transactionId: fixture.transactionId,
          onchainId: fixture.onchainId,
          order: fixture.order,
          orderSignature: "0x" + "00".repeat(65),
          nonce: "explicit-nonce",
        }),
      ).rejects.toThrow("Only single-output payment orders are allowed");
    });

    it("maps input-currency order fees into the execute-and-withdraw request", async () => {
      const fixture = await buildWithdrawAndFillFixture({
        withFees: true,
      });
      const nonce = "explicit-nonce";

      const result = await service.attestWithdrawAndFill({
        chainId: "ethereum",
        transactionId: fixture.transactionId,
        onchainId: fixture.onchainId,
        order: fixture.order,
        orderSignature: "0x" + "00".repeat(65),
        nonce,
      });

      const feeRecipientAlias = generateAddress({
        address: "0x5555555555555555555555555555555555555555",
        chainId: "ethereum",
        family: "ethereum-vm",
      });
      expect(result.executeAndWithdrawRequest.fees).toEqual([
        {
          recipient: feeRecipientAlias,
          amount: "1",
        },
      ]);
    });

    it("rejects fees not denominated in the input currency", async () => {
      const fixture = await buildWithdrawAndFillFixture({
        wrongFeeCurrency: true,
      });

      await expect(
        service.attestWithdrawAndFill({
          chainId: "ethereum",
          transactionId: fixture.transactionId,
          onchainId: fixture.onchainId,
          order: fixture.order,
          orderSignature: "0x" + "00".repeat(65),
          nonce: "explicit-nonce",
        }),
      ).rejects.toThrow("Fee currency must match the input currency");
    });
  });

  describe("attestWithdrawAndRefund", () => {
    const refundRecipient = "0x7777777777777777777777777777777777777777";

    const buildWithdrawAndRefundFixture = async (overrides?: {
      refunds?: Order["inputs"][number]["refunds"];
    }) => {
      const solverAddress = "0x1234567890123456789012345678901234567890";
      const depositor = "0x0987654321098765432109876543210987654321";
      const currency = "0x1111111111111111111111111111111111111111";
      const amount = "1000";
      const timestamp = "1234567890";
      const transactionId =
        "0x552985b36c59902b24fde1437a11a2698347aa5ca2bf82697d0f8e8e1e35cc6e";
      const onchainId =
        "0x0000000000000000000000000000000000000000000000000000000000000999";

      const order: Order = {
        version: "v1",
        salt: "0x1",
        solverChainId: "ethereum",
        solver: solverAddress,
        inputs: [
          {
            payment: {
              chainId: "ethereum",
              currency,
              amount,
              weight: "1",
            },
            refunds: overrides?.refunds ?? [
              {
                chainId: "ethereum",
                recipient: refundRecipient,
                currency,
                minimumAmount: amount,
                deadline: Math.floor(Date.now() / 1000) + 3600,
                extraData: "0x",
              },
            ],
          },
        ],
        output: {
          chainId: "ethereum",
          payments: [
            {
              recipient: "0x3333333333333333333333333333333333333333",
              currency,
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

      const orderId = getOrderId(order, await getSdkChainsConfig());
      const mockDepositMessage = {
        data: {
          chainId: "ethereum",
          transactionId,
        },
        result: {
          depositor,
          depository: "0x4444444444444444444444444444444444444444",
          currency,
          amount,
          onchainId,
          depositId: orderId,
        },
        extraData: { timestamp },
      };

      const mockAttestor: any = {
        getDepositoryDepositMessages: jest
          .fn()
          .mockImplementation(() => Promise.resolve([mockDepositMessage])),
      };
      mockGetVmAttestor.mockResolvedValue(mockAttestor);

      return {
        order,
        orderId,
        transactionId,
        onchainId,
        amount,
        currency,
        depositor,
        timestamp,
      };
    };

    it("refunds the input currency back to the refund recipient", async () => {
      const fixture = await buildWithdrawAndRefundFixture();
      const nonce = "explicit-nonce";

      const result = await service.attestWithdrawAndRefund({
        chainId: "ethereum",
        transactionId: fixture.transactionId,
        onchainId: fixture.onchainId,
        order: fixture.order,
        orderSignature: "0x" + "00".repeat(65),
        nonce,
      });

      expect(result.execution).toBeDefined();

      const orderHash = keccak256(
        encodePacked(
          ["string", "bytes", "uint256", "bytes32"],
          [
            "ethereum",
            `0x${Buffer.from(
              encodeAddress(fixture.depositor, "ethereum-vm"),
            ).toString("hex")}`,
            BigInt(fixture.timestamp),
            fixture.orderId as Hex,
          ],
        ),
      );
      const expectedOrderAddress = `0x${orderHash
        .slice(2)
        .slice(-40)}` as `0x${string}`;

      expect(result.executeAndWithdrawRequest).toEqual({
        inChainId: "ethereum",
        inCurrency: `0x${Buffer.from(
          encodeAddress(fixture.currency, "ethereum-vm"),
        ).toString("hex")}`,
        outChainId: "ethereum",
        outCurrency: `0x${Buffer.from(
          encodeAddress(fixture.currency, "ethereum-vm"),
        ).toString("hex")}`,
        outAmountMinimum: fixture.amount,
        depository: `0x${Buffer.from(
          encodeAddress(depositoryAddress, "ethereum-vm"),
        ).toString("hex")}`,
        orderAddress: expectedOrderAddress,
        receiver: `0x${Buffer.from(
          encodeAddress(refundRecipient, "ethereum-vm"),
        ).toString("hex")}`,
        data: "0x",
        fees: [],
        nonce,
        deadline: fixture.order.inputs[0].refunds[0].deadline.toString(),
      });
    });

    it("rejects when no refund matches the input currency/chain", async () => {
      const fixture = await buildWithdrawAndRefundFixture({
        refunds: [
          {
            chainId: "ethereum",
            recipient: refundRecipient,
            currency: "0x9999999999999999999999999999999999999999",
            minimumAmount: "1000",
            deadline: Math.floor(Date.now() / 1000) + 3600,
            extraData: "0x",
          },
        ],
      });

      await expect(
        service.attestWithdrawAndRefund({
          chainId: "ethereum",
          transactionId: fixture.transactionId,
          onchainId: fixture.onchainId,
          order: fixture.order,
          orderSignature: "0x" + "00".repeat(65),
          nonce: "explicit-nonce",
        }),
      ).rejects.toThrow("Non-matching refund option");
    });

    it("rejects when multiple refunds match the input currency/chain", async () => {
      const fixture = await buildWithdrawAndRefundFixture({
        refunds: [
          {
            chainId: "ethereum",
            recipient: refundRecipient,
            currency: "0x1111111111111111111111111111111111111111",
            minimumAmount: "1000",
            deadline: Math.floor(Date.now() / 1000) + 3600,
            extraData: "0x",
          },
          {
            chainId: "ethereum",
            recipient: refundRecipient,
            currency: "0x1111111111111111111111111111111111111111",
            minimumAmount: "500",
            deadline: Math.floor(Date.now() / 1000) + 3600,
            extraData: "0x",
          },
        ],
      });

      await expect(
        service.attestWithdrawAndRefund({
          chainId: "ethereum",
          transactionId: fixture.transactionId,
          onchainId: fixture.onchainId,
          order: fixture.order,
          orderSignature: "0x" + "00".repeat(65),
          nonce: "explicit-nonce",
        }),
      ).rejects.toThrow("Only single-refund options are allowed");
    });
  });

  describe("attestSolverFill", () => {
    it(`returns correct execution data with solver fill execution`, async () => {
      const solverAddress = "0x1234567890123456789012345678901234567890";
      const depositor = "0x0987654321098765432109876543210987654321";
      const currency = "0x1111111111111111111111111111111111111111";
      const amount = "1000";
      const timestamp = "1234567890";
      const transactionId =
        "0x552985b36c59902b24fde1437a11a2698347aa5ca2bf82697d0f8e8e1e35cc6e";
      const fillTransactionId =
        "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
      const onchainId =
        "0x0000000000000000000000000000000000000000000000000000000000000999";

      const order: Order = {
        version: "v1",
        salt: "0x1",
        solverChainId: "ethereum",
        solver: solverAddress,
        inputs: [
          {
            payment: {
              chainId: "ethereum",
              currency,
              amount,
              weight: "1",
            },
            refunds: [],
          },
        ],
        output: {
          chainId: "ethereum",
          payments: [
            {
              recipient: "0x3333333333333333333333333333333333333333",
              currency,
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

      const orderId = getOrderId(order, await getSdkChainsConfig());

      const mockDepositMessage = {
        data: {
          chainId: "ethereum",
          transactionId,
        },
        result: {
          depositor,
          depository: "0x4444444444444444444444444444444444444444",
          currency,
          amount,
          onchainId,
          depositId: orderId,
        },
        extraData: { timestamp },
      };

      const mockAttestor: any = {
        getDepositoryDepositMessages: jest
          .fn()
          .mockImplementation(() => Promise.resolve([mockDepositMessage])),
        getSolverPaidAmount: jest
          .fn()
          .mockImplementation(() => Promise.resolve(BigInt(amount))),
        verifySolverCalls: jest
          .fn()
          .mockImplementation(() => Promise.resolve(true)),
      };

      mockGetVmAttestor.mockResolvedValue(mockAttestor);

      const requestBody = {
        order,
        orderSignature: "0x" + "00".repeat(65), // Mock signature
        inputs: [
          {
            transactionId,
            onchainId,
            inputIndex: 0,
          },
        ],
        fill: {
          transactionId: fillTransactionId,
        },
      };

      const result = await service.attestSolverFill(requestBody);

      expect(result.message).toBeDefined();
      expect(result.message.data).toEqual(requestBody);
      expect(result.message.result.orderId).toBe(orderId);

      expect(result.execution).toBeDefined();
      expect(result.execution?.actions.length).toBeGreaterThan(0);

      // TRANSFER actions from order to solver
      const hubTokenId = generateTokenId({
        address: currency,
        chainId: "ethereum",
        family: "ethereum-vm",
      });

      const solverAlias = generateAddress({
        address: solverAddress,
        chainId: "ethereum",
        family: "ethereum-vm",
      });

      // miror _getOrderAddress
      const orderHash = keccak256(
        encodePacked(
          ["string", "bytes", "uint256", "bytes32"],
          [
            "ethereum",
            `0x${Buffer.from(encodeAddress(depositor, "ethereum-vm")).toString(
              "hex",
            )}`,
            BigInt(timestamp),
            orderId as Hex,
          ],
        ),
      );
      const expectedOrderAddress = `0x${orderHash
        .slice(2)
        .slice(-40)}` as `0x${string}`;

      // fill = TRANSFER from order to solver
      const [firstAction] = result.execution?.actions || [];
      const decodedFirstAction = decodeAction(firstAction);
      expect(decodedFirstAction.type).toBe(ActionType.TRANSFER);
      if (decodedFirstAction.type === ActionType.TRANSFER) {
        expect(decodedFirstAction.data.hubTokenId).toBe(hubTokenId);
        expect(decodedFirstAction.data.hubFromAddress.toLowerCase()).toBe(
          expectedOrderAddress.toLowerCase(),
        );
        expect(decodedFirstAction.data.hubToAddress).toBe(solverAlias);
        expect(decodedFirstAction.data.amount).toBe(
          order.output.payments[0].expectedAmount,
        );
      }
    });

    it(`does not scale minimum output amount on input overpayment`, async () => {
      const solverAddress = "0x1234567890123456789012345678901234567890";
      const depositor = "0x0987654321098765432109876543210987654321";
      const currency = "0x1111111111111111111111111111111111111111";
      const orderAmount = "1000";
      const depositAmount = "1200"; // 20% overpayment
      const minimumOutputAmount = "900";
      const timestamp = "1234567890";
      const transactionId =
        "0x552985b36c59902b24fde1437a11a2698347aa5ca2bf82697d0f8e8e1e35cc6e";
      const fillTransactionId =
        "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
      const onchainId =
        "0x0000000000000000000000000000000000000000000000000000000000000999";

      const order: Order = {
        version: "v1",
        salt: "0x1",
        solverChainId: "ethereum",
        solver: solverAddress,
        inputs: [
          {
            payment: {
              chainId: "ethereum",
              currency,
              amount: orderAmount,
              weight: "1",
            },
            refunds: [],
          },
        ],
        output: {
          chainId: "ethereum",
          payments: [
            {
              recipient: "0x3333333333333333333333333333333333333333",
              currency,
              minimumAmount: minimumOutputAmount,
              expectedAmount: orderAmount,
            },
          ],
          calls: [],
          extraData: "0x",
          deadline: Math.floor(Date.now() / 1000) + 3600,
        },
        fees: [],
      };

      const orderId = getOrderId(order, await getSdkChainsConfig());

      const mockDepositMessage = {
        data: { chainId: "ethereum", transactionId },
        result: {
          depositor,
          depository: "0x4444444444444444444444444444444444444444",
          currency,
          amount: depositAmount, // Overpayment
          onchainId,
          depositId: orderId,
        },
        extraData: { timestamp },
      };

      const mockAttestor: any = {
        getDepositoryDepositMessages: jest
          .fn()
          .mockImplementation(() => Promise.resolve([mockDepositMessage])),
        // Solver pays exactly the unscaled minimum - should be accepted
        getSolverPaidAmount: jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve(BigInt(minimumOutputAmount)),
          ),
        verifySolverCalls: jest
          .fn()
          .mockImplementation(() => Promise.resolve(true)),
      };

      mockGetVmAttestor.mockResolvedValue(mockAttestor);

      const result = await service.attestSolverFill({
        order,
        orderSignature: "0x" + "00".repeat(65),
        inputs: [{ transactionId, onchainId, inputIndex: 0 }],
        fill: { transactionId: fillTransactionId },
      });

      // Should succeed with the unscaled minimum amount
      expect(result.message.result.status).toBe(SolverFillStatus.SUCCESSFUL);
      // The bps diff should reflect the overpayment
      expect(
        BigInt(result.message.result.totalWeightedInputPaymentBpsDiff),
      ).toBeGreaterThan(0n);
    });

    it(`does not scale fees in execution on input overpayment`, async () => {
      const solverAddress = "0x1234567890123456789012345678901234567890";
      const depositor = "0x0987654321098765432109876543210987654321";
      const currency = "0x1111111111111111111111111111111111111111";
      const orderAmount = "1000";
      const depositAmount = "1200"; // 20% overpayment
      const feeAmount = "100";
      const feeRecipient = "0x5555555555555555555555555555555555555555";
      const timestamp = "1234567890";
      const transactionId =
        "0x552985b36c59902b24fde1437a11a2698347aa5ca2bf82697d0f8e8e1e35cc6e";
      const fillTransactionId =
        "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
      const onchainId =
        "0x0000000000000000000000000000000000000000000000000000000000000999";

      const order: Order = {
        version: "v1",
        salt: "0x1",
        solverChainId: "ethereum",
        solver: solverAddress,
        inputs: [
          {
            payment: {
              chainId: "ethereum",
              currency,
              amount: orderAmount,
              weight: "1",
            },
            refunds: [],
          },
        ],
        output: {
          chainId: "ethereum",
          payments: [
            {
              recipient: "0x3333333333333333333333333333333333333333",
              currency,
              minimumAmount: orderAmount,
              expectedAmount: orderAmount,
            },
          ],
          calls: [],
          extraData: "0x",
          deadline: Math.floor(Date.now() / 1000) + 3600,
        },
        fees: [
          {
            recipientChainId: "ethereum",
            recipient: feeRecipient,
            currencyChainId: "ethereum",
            currency,
            amount: feeAmount,
          },
        ],
      };

      const orderId = getOrderId(order, await getSdkChainsConfig());

      const mockDepositMessage = {
        data: { chainId: "ethereum", transactionId },
        result: {
          depositor,
          depository: "0x4444444444444444444444444444444444444444",
          currency,
          amount: depositAmount, // Overpayment
          onchainId,
          depositId: orderId,
        },
        extraData: { timestamp },
      };

      const mockAttestor: any = {
        getDepositoryDepositMessages: jest
          .fn()
          .mockImplementation(() => Promise.resolve([mockDepositMessage])),
        getSolverPaidAmount: jest
          .fn()
          .mockImplementation(() => Promise.resolve(BigInt(orderAmount))),
        verifySolverCalls: jest
          .fn()
          .mockImplementation(() => Promise.resolve(true)),
      };

      mockGetVmAttestor.mockResolvedValue(mockAttestor);

      const result = await service.attestSolverFill({
        order,
        orderSignature: "0x" + "00".repeat(65),
        inputs: [{ transactionId, onchainId, inputIndex: 0 }],
        fill: { transactionId: fillTransactionId },
      });

      // Fee action should use the unscaled fee amount
      const feeAction = result.execution!.actions[1];
      const decodedFeeAction = decodeAction(feeAction);
      expect(decodedFeeAction.type).toBe(ActionType.TRANSFER);
      if (decodedFeeAction.type === ActionType.TRANSFER) {
        expect(decodedFeeAction.data.amount).toBe(feeAmount);
      }
    });
  });

  describe("attestSolverRefund", () => {
    it(`scales refund minimum amount on input overpayment`, async () => {
      const solverAddress = "0x1234567890123456789012345678901234567890";
      const depositor = "0x0987654321098765432109876543210987654321";
      const currency = "0x1111111111111111111111111111111111111111";
      const orderAmount = "1000";
      const depositAmount = "1200"; // 20% overpayment
      const refundMinimumAmount = "900";
      const refundRecipient = "0x6666666666666666666666666666666666666666";
      const solverContractAddress =
        "0x7777777777777777777777777777777777777777";
      const timestamp = "1234567890";
      const transactionId =
        "0x552985b36c59902b24fde1437a11a2698347aa5ca2bf82697d0f8e8e1e35cc6e";
      const refundTransactionId =
        "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
      const onchainId =
        "0x0000000000000000000000000000000000000000000000000000000000000999";

      const order: Order = {
        version: "v1",
        salt: "0x1",
        solverChainId: "ethereum",
        solver: solverAddress,
        inputs: [
          {
            payment: {
              chainId: "ethereum",
              currency,
              amount: orderAmount,
              weight: "1",
            },
            refunds: [
              {
                chainId: "ethereum",
                recipient: refundRecipient,
                currency,
                minimumAmount: refundMinimumAmount,
                deadline: Math.floor(Date.now() / 1000) + 36000,
                extraData: encodeAbiParameters(
                  [{ type: "address" }],
                  [solverContractAddress as Hex],
                ),
              },
            ],
          },
        ],
        output: {
          chainId: "ethereum",
          payments: [
            {
              recipient: "0x3333333333333333333333333333333333333333",
              currency,
              minimumAmount: orderAmount,
              expectedAmount: orderAmount,
            },
          ],
          calls: [],
          extraData: "0x",
          deadline: Math.floor(Date.now() / 1000) + 3600,
        },
        fees: [],
      };

      const orderId = getOrderId(order, await getSdkChainsConfig());

      // 20% overpayment means bpsDiff = 0.2 * 10^18 = 200000000000000000
      // Scaled refund minimum = 900 + (900 * 200000000000000000) / 10^18 = 900 + 180 = 1080
      const scaledRefundMinimum =
        BigInt(refundMinimumAmount) +
        (BigInt(refundMinimumAmount) *
          ((BigInt(depositAmount) - BigInt(orderAmount)) * 10n ** 18n)) /
          BigInt(orderAmount) /
          10n ** 18n;

      const mockDepositMessage = {
        data: { chainId: "ethereum", transactionId },
        result: {
          depositor,
          depository: "0x4444444444444444444444444444444444444444",
          currency,
          amount: depositAmount, // Overpayment
          onchainId,
          depositId: orderId,
        },
        extraData: { timestamp },
      };

      const mockAttestor: any = {
        getDepositoryDepositMessages: jest
          .fn()
          .mockImplementation(() => Promise.resolve([mockDepositMessage])),
        // Pays exactly the scaled minimum - should succeed
        getSolverPaidAmount: jest
          .fn()
          .mockImplementation(() => Promise.resolve(scaledRefundMinimum)),
        verifySolverCalls: jest
          .fn()
          .mockImplementation(() => Promise.resolve(true)),
      };

      mockGetVmAttestor.mockResolvedValue(mockAttestor);

      const result = await service.attestSolverRefund({
        order,
        orderSignature: "0x" + "00".repeat(65),
        inputs: [{ transactionId, onchainId, inputIndex: 0 }],
        refunds: [
          {
            transactionId: refundTransactionId,
            inputIndex: 0,
            refundIndex: 0,
          },
        ],
      });

      expect(result.message.result.status).toBe(SolverRefundStatus.SUCCESSFUL);
      expect(
        BigInt(result.message.result.totalWeightedInputPaymentBpsDiff),
      ).toBeGreaterThan(0n);
    });

    it(`fails refund when paying unscaled minimum on input overpayment`, async () => {
      const solverAddress = "0x1234567890123456789012345678901234567890";
      const depositor = "0x0987654321098765432109876543210987654321";
      const currency = "0x1111111111111111111111111111111111111111";
      const orderAmount = "1000";
      const depositAmount = "1200"; // 20% overpayment
      const refundMinimumAmount = "900";
      const refundRecipient = "0x6666666666666666666666666666666666666666";
      const solverContractAddress =
        "0x7777777777777777777777777777777777777777";
      const timestamp = "1234567890";
      const transactionId =
        "0x552985b36c59902b24fde1437a11a2698347aa5ca2bf82697d0f8e8e1e35cc6e";
      const refundTransactionId =
        "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
      const onchainId =
        "0x0000000000000000000000000000000000000000000000000000000000000999";

      const order: Order = {
        version: "v1",
        salt: "0x1",
        solverChainId: "ethereum",
        solver: solverAddress,
        inputs: [
          {
            payment: {
              chainId: "ethereum",
              currency,
              amount: orderAmount,
              weight: "1",
            },
            refunds: [
              {
                chainId: "ethereum",
                recipient: refundRecipient,
                currency,
                minimumAmount: refundMinimumAmount,
                deadline: Math.floor(Date.now() / 1000) + 36000,
                extraData: encodeAbiParameters(
                  [{ type: "address" }],
                  [solverContractAddress as Hex],
                ),
              },
            ],
          },
        ],
        output: {
          chainId: "ethereum",
          payments: [
            {
              recipient: "0x3333333333333333333333333333333333333333",
              currency,
              minimumAmount: orderAmount,
              expectedAmount: orderAmount,
            },
          ],
          calls: [],
          extraData: "0x",
          deadline: Math.floor(Date.now() / 1000) + 3600,
        },
        fees: [],
      };

      const orderId = getOrderId(order, await getSdkChainsConfig());

      const mockDepositMessage = {
        data: { chainId: "ethereum", transactionId },
        result: {
          depositor,
          depository: "0x4444444444444444444444444444444444444444",
          currency,
          amount: depositAmount, // Overpayment
          onchainId,
          depositId: orderId,
        },
        extraData: { timestamp },
      };

      const mockAttestor: any = {
        getDepositoryDepositMessages: jest
          .fn()
          .mockImplementation(() => Promise.resolve([mockDepositMessage])),
        // Pays only the unscaled minimum - should fail because refund minimum IS scaled
        getSolverPaidAmount: jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve(BigInt(refundMinimumAmount)),
          ),
        verifySolverCalls: jest
          .fn()
          .mockImplementation(() => Promise.resolve(true)),
      };

      mockGetVmAttestor.mockResolvedValue(mockAttestor);

      await expect(
        service.attestSolverRefund({
          order,
          orderSignature: "0x" + "00".repeat(65),
          inputs: [{ transactionId, onchainId, inputIndex: 0 }],
          refunds: [
            {
              transactionId: refundTransactionId,
              inputIndex: 0,
              refundIndex: 0,
            },
          ],
        }),
      ).rejects.toThrow("Insufficient refund amount");
    });
  });

  describe("attestRecover", () => {
    const depositor = "0x1234567890123456789012345678901234567890";
    const currency = "0x1111111111111111111111111111111111111111";
    const amount = "1000";
    const chainId = "ethereum";
    const transactionId =
      "0x552985b36c59902b24fde1437a11a2698347aa5ca2bf82697d0f8e8e1e35cc6e";
    const onchainId =
      "0x0000000000000000000000000000000000000000000000000000000000000999";
    const depositId = keccak256("0x1234" as Hex);
    const solverAddress = "0x0987654321098765432109876543210987654321";

    // Timestamp older than 7 days
    const oldTimestamp = String(
      Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60,
    );
    // Timestamp within 7 days
    const recentTimestamp = String(
      Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60,
    );

    const mockDepositMessage = (
      overrides: Record<string, any> = {},
      extraOverrides: Record<string, any> = {},
    ) => ({
      data: { chainId, transactionId },
      result: {
        depositor,
        depository: depositoryAddress,
        currency,
        amount,
        onchainId,
        depositId,
        ...overrides,
      },
      extraData: { timestamp: oldTimestamp, ...extraOverrides },
    });

    const setupMockAttestor = (messages: any[]) => {
      const mockAttestor: any = {
        getDepositoryDepositMessages: jest
          .fn()
          .mockImplementation(() => Promise.resolve(messages)),
      };
      mockGetVmAttestor.mockResolvedValue(mockAttestor);
    };

    it("returns correct TRANSFER execution for deposit older than 7 days", async () => {
      const deposit = mockDepositMessage();
      setupMockAttestor([deposit]);
      jest.mocked(getBalanceOnHub).mockResolvedValue(BigInt(amount));

      const result = await service.attestRecover({
        chainId,
        transactionId,
        onchainId,
      });

      const hubTokenId = generateTokenId({
        address: currency,
        chainId,
        family: "ethereum-vm",
      });

      // Mirror _getOrderAddress
      const orderHash = keccak256(
        encodePacked(
          ["string", "bytes", "uint256", "bytes32"],
          [
            chainId,
            `0x${Buffer.from(encodeAddress(depositor, "ethereum-vm")).toString("hex")}`,
            BigInt(oldTimestamp),
            depositId as Hex,
          ],
        ),
      );
      const expectedOrderAddress = `0x${orderHash.slice(2).slice(-40)}`;

      const depositorAlias = generateAddress({
        address: depositor,
        chainId,
        family: "ethereum-vm",
      });

      expect(result.execution).toBeDefined();
      expect(result.execution.idempotencyKey).toBe(
        getDeterministicId(onchainId, "recover"),
      );
      expect(result.execution.actions.length).toBe(1);

      const decoded = decodeAction(result.execution.actions[0]);
      expect(decoded.type).toBe(ActionType.TRANSFER);
      if (decoded.type === ActionType.TRANSFER) {
        expect(decoded.data.hubTokenId).toBe(hubTokenId);
        expect(decoded.data.hubFromAddress.toLowerCase()).toBe(
          expectedOrderAddress.toLowerCase(),
        );
        expect(decoded.data.hubToAddress).toBe(depositorAlias);
        expect(decoded.data.amount).toBe(amount);
      }
    });

    it("throws when deposit not found in transaction", async () => {
      setupMockAttestor([]);

      await expect(
        service.attestRecover({
          chainId,
          transactionId,
          onchainId,
        }),
      ).rejects.toThrow(
        `Deposit with onchainId ${onchainId} not found in transaction`,
      );
    });

    it("throws when deposit has no depositId (zeroHash)", async () => {
      const deposit = mockDepositMessage({ depositId: zeroHash });
      setupMockAttestor([deposit]);

      await expect(
        service.attestRecover({
          chainId,
          transactionId,
          onchainId,
        }),
      ).rejects.toThrow("Deposit does not have a depositId");
    });

    it("throws when balance is insufficient", async () => {
      const deposit = mockDepositMessage();
      setupMockAttestor([deposit]);
      jest.mocked(getBalanceOnHub).mockResolvedValue(0n);

      await expect(
        service.attestRecover({
          chainId,
          transactionId,
          onchainId,
        }),
      ).rejects.toThrow("Insufficient balance at order address for recovery");
    });

    it("throws when deposit is recent and no order data provided", async () => {
      const deposit = mockDepositMessage({}, { timestamp: recentTimestamp });
      setupMockAttestor([deposit]);
      jest.mocked(getBalanceOnHub).mockResolvedValue(BigInt(amount));

      await expect(
        service.attestRecover({
          chainId,
          transactionId,
          onchainId,
        }),
      ).rejects.toThrow(
        "Order data and signature are required for deposits less than 7 days old",
      );
    });

    it("throws when deposit is recent and orderId does not match depositId", async () => {
      const order: Order = {
        version: "v1",
        salt: "0x1",
        solverChainId: "ethereum",
        solver: solverAddress,
        inputs: [
          {
            payment: { chainId, currency, amount, weight: "1" },
            refunds: [],
          },
        ],
        output: {
          chainId: "ethereum",
          payments: [
            {
              recipient: "0x3333333333333333333333333333333333333333",
              currency,
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

      // Use a depositId that won't match the computed orderId
      const mismatchedDepositId = keccak256("0xdead" as Hex);
      const deposit = mockDepositMessage(
        { depositId: mismatchedDepositId },
        { timestamp: recentTimestamp },
      );
      setupMockAttestor([deposit]);
      jest.mocked(getBalanceOnHub).mockResolvedValue(BigInt(amount));

      await expect(
        service.attestRecover({
          chainId,
          transactionId,
          onchainId,
          order,
          orderSignature: "0x" + "00".repeat(65),
        }),
      ).rejects.toThrow(
        "Deposit depositId does not match the computed orderId",
      );
    });

    it("throws when deposit is recent and order signature is invalid", async () => {
      const order: Order = {
        version: "v1",
        salt: "0x1",
        solverChainId: "ethereum",
        solver: solverAddress,
        inputs: [
          {
            payment: { chainId, currency, amount, weight: "1" },
            refunds: [],
          },
        ],
        output: {
          chainId: "ethereum",
          payments: [
            {
              recipient: "0x3333333333333333333333333333333333333333",
              currency,
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

      const orderId = getOrderId(order, await getSdkChainsConfig());
      const deposit = mockDepositMessage(
        { depositId: orderId },
        { timestamp: recentTimestamp },
      );
      setupMockAttestor([deposit]);
      jest.mocked(getBalanceOnHub).mockResolvedValue(BigInt(amount));
      jest.mocked(verifyMessage).mockResolvedValueOnce(false);

      await expect(
        service.attestRecover({
          chainId,
          transactionId,
          onchainId,
          order,
          orderSignature: "0x" + "00".repeat(65),
        }),
      ).rejects.toThrow("Invalid order signature");
    });

    it("throws when deposit is recent and no fill or refund entry not found", async () => {
      const order: Order = {
        version: "v1",
        salt: "0x1",
        solverChainId: "ethereum",
        solver: solverAddress,
        inputs: [
          {
            payment: { chainId, currency, amount, weight: "1" },
            refunds: [],
          },
        ],
        output: {
          chainId: "ethereum",
          payments: [
            {
              recipient: "0x3333333333333333333333333333333333333333",
              currency,
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

      const orderId = getOrderId(order, await getSdkChainsConfig());
      const deposit = mockDepositMessage(
        { depositId: orderId },
        { timestamp: recentTimestamp },
      );
      setupMockAttestor([deposit]);
      jest.mocked(getBalanceOnHub).mockResolvedValue(BigInt(amount));

      // Mock getHubHttpRpc to return a client that getContract can use
      const { getHubHttpRpc } = jest.requireMock(
        "../../../../src/common/hub",
      ) as any;
      getHubHttpRpc.mockResolvedValue({
        readContract: jest.fn<any>().mockResolvedValue(["0x", 0n]),
      });

      await expect(
        service.attestRecover({
          chainId,
          transactionId,
          onchainId,
          order,
          orderSignature: "0x" + "00".repeat(65),
        }),
      ).rejects.toThrow("No fill or refund entry not found for this order");
    });

    it("returns correct execution for recent deposit with valid order and no-fill-or-refund", async () => {
      const order: Order = {
        version: "v1",
        salt: "0x1",
        solverChainId: "ethereum",
        solver: solverAddress,
        inputs: [
          {
            payment: { chainId, currency, amount, weight: "1" },
            refunds: [],
          },
        ],
        output: {
          chainId: "ethereum",
          payments: [
            {
              recipient: "0x3333333333333333333333333333333333333333",
              currency,
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

      const orderId = getOrderId(order, await getSdkChainsConfig());
      const deposit = mockDepositMessage(
        { depositId: orderId },
        { timestamp: recentTimestamp },
      );
      setupMockAttestor([deposit]);
      jest.mocked(getBalanceOnHub).mockResolvedValue(BigInt(amount));

      // Mock getHubHttpRpc to return a client where getEntry returns a valid entry
      const { getHubHttpRpc } = jest.requireMock(
        "../../../../src/common/hub",
      ) as any;
      getHubHttpRpc.mockResolvedValue({
        readContract: jest.fn<any>().mockResolvedValue(["0x01", 1000n]),
      });

      const result = await service.attestRecover({
        chainId,
        transactionId,
        onchainId,
        order,
        orderSignature: "0x" + "00".repeat(65),
      });

      const hubTokenId = generateTokenId({
        address: currency,
        chainId,
        family: "ethereum-vm",
      });

      const depositorAlias = generateAddress({
        address: depositor,
        chainId,
        family: "ethereum-vm",
      });

      expect(result.execution).toBeDefined();
      expect(result.execution.idempotencyKey).toBe(
        getDeterministicId(onchainId, "recover"),
      );
      expect(result.execution.actions.length).toBe(1);

      const decoded = decodeAction(result.execution.actions[0]);
      expect(decoded.type).toBe(ActionType.TRANSFER);
      if (decoded.type === ActionType.TRANSFER) {
        expect(decoded.data.hubTokenId).toBe(hubTokenId);
        expect(decoded.data.hubToAddress).toBe(depositorAlias);
        expect(decoded.data.amount).toBe(amount);
      }
    });
  });
});

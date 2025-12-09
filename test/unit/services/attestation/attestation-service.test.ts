import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { AttestationService } from "../../../../src/services/attestation";
import { getVmAttestor } from "../../../../src/services/attestation/vm";
import { getDeterministicId } from "../../../../src/services/attestation/vm/utils";
import {
  ActionType,
  decodeAction,
  DepositoryWithdrawalStatus,
  encodeWithdrawal,
  decodeWithdrawal,
  getDecodedWithdrawalCurrency,
} from "@reservoir0x/relay-protocol-sdk";
import {
  getChainHubChainId,
  getChainVmType,
} from "../../../../src/common/chains";
import { generateTokenId, generateAddress } from "@relay-protocol/hub-utils";

jest.mock("../../../../src/services/attestation/vm");
jest.mock("../../../../src/common/chains");

// Mock signature verification
jest.mock("viem", () => {
  const viem = jest.requireActual("viem") as typeof import("viem");
  return {
    ...viem,
    verifyMessage: jest.fn().mockImplementation(() => Promise.resolve(true)),
  };
});

jest.mock("../../../../src/common/chains", () => ({
  getChainVmType: jest.fn().mockImplementation(async (chainId: string) => {
    if (chainId === "ethereum") return "ethereum-vm";
    if (chainId === "solana") return "solana-vm";
    throw new Error("Unknown chain");
  }),
  getChainHubChainId: jest.fn().mockImplementation(async (chainId: string) => {
    if (chainId === "ethereum") return 1;
    if (chainId === "solana") return 101;
    throw new Error("Unknown chain");
  }),
  getHubChains: jest.fn().mockImplementation(async () => [
    {
      chainId: "ethereum",
      vmType: "ethereum-vm",
      hubChainId: "1",
      additionalData: { oracleAddress: "0xoracleETH" },
    },
    {
      chainId: "solana",
      hubChainId: "101",
      vmType: "solana-vm",
      additionalData: { oracleAddress: "0xoracleSOL" },
    },
  ]),
  getSdkChainsConfig: jest.fn(() => ({
    ethereum: "ethereum-vm",
    solana: "solana-vm",
  })),
}));

const mockGetVmAttestor = jest.mocked(getVmAttestor);

describe("AttestationService", () => {
  const service = new AttestationService();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("attestDepositoryDeposits", () => {
    it(`returns correct execution data with deposit id`, async () => {
      const requestBody = {
        chainId: "ethereum",
        transactionId:
          "0x552985b36c59902b24fde1437a11a2698347aa5ca2bf82697d0f8e8e1e35cc6e",
        includeOnchainHubExecution: true,
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
        mockMessage.data.transactionId
      );

      const hubTokenId = generateTokenId({
        address: mockMessage.result.currency,
        chainId: await getChainHubChainId(mockMessage.data.chainId),
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
          hubToAddress: "0xe39b9B20E42513E0e1F1A4a5C5056166eaDc9eBE",
          amount: mockMessage.result.amount,
        },
      });
    });
  });

  describe("attestDepositoryWithdrawals", () => {
    // TODO: replace with computed withdrawal address
    const BASE_SOLVER_ADDRESS = "0xf70da97812cb96acdf810712aa562db8dfa3dbef";
    const baseSolverAlias = generateAddress({
      address: BASE_SOLVER_ADDRESS,
      chainId: BigInt(8453),
      family: "ethereum-vm",
    });

    it(`returns correct execution data with withdrawal execution for ethereum-vm`, async () => {
      const recipient = "0xf70da97812cb96acdf810712aa562db8dfa3dbef";
      const amount = "1000";

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

      const requestBody = {
        chainId: "ethereum",
        withdrawal,
        transactionId:
          "0x552985b36c59902b24fde1437a11a2698347aa5ca2bf82697d0f8e8e1e35cc6e",
        includeOnchainHubExecution: true,
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

      // Decode the withdrawal to get the actual currency
      const actualDecodedWithdrawal = decodeWithdrawal(
        withdrawal,
        "ethereum-vm"
      );
      const actualCurrency = getDecodedWithdrawalCurrency(
        actualDecodedWithdrawal
      );

      const result = await service.attestDepositoryWithdrawal(requestBody);
      const idempotencyKey = getDeterministicId(
        mockMessage.result.withdrawalId,
        requestBody.transactionId!
      );

      const hubTokenId = generateTokenId({
        address: actualCurrency,
        chainId: await getChainHubChainId(requestBody.chainId),
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
          hubFromAddress: baseSolverAlias,
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
          recipient,
          token: currency,
          amount,
          nonce: "0",
          expiration: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
        },
      };

      const withdrawal = encodeWithdrawal(decodedWithdrawal);

      const requestBody = {
        chainId: "solana",
        withdrawal,
        transactionId:
          "5j7s8K9j2k3l4m5n6o7p8q9r0s1t2u3v4w5x6y7z8a9b0c1d2e3f4g5h6i7j8k9l0m1n2o3p4",
        includeOnchainHubExecution: true,
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
          depository: "7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ",
          status: DepositoryWithdrawalStatus.EXECUTED,
        },
      };

      const mockAttestor: any = {
        getDepositoryWithdrawalMessage: jest
          .fn()
          .mockImplementation(() => Promise.resolve(mockMessage)),
      };

      mockGetVmAttestor.mockResolvedValue(mockAttestor);

      const result = await service.attestDepositoryWithdrawal(requestBody);
      const idempotencyKey = getDeterministicId(
        mockMessage.result.withdrawalId,
        requestBody.transactionId!
      );

      const hubTokenId = generateTokenId({
        address: currency,
        chainId: await getChainHubChainId(requestBody.chainId),
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
          hubFromAddress: baseSolverAlias,
          amount,
        },
      });
    });
  });
});

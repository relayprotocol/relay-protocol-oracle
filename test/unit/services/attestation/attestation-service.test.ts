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
    },
    solana: {
      id: "solana",
      vmType: "solana-vm",
      httpRpcUrl: "http://127.0.0.1:8545",
      depository: "FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u",
      hubChainId:
        "50176979118388105370421134508366610418687875236156196470082648173271157915018",
    },
  };
  return {
    HUB_VM_TYPE: "hub-vm",
    HUB_CHAIN_ID: 0n,
    getChains: async () => chains,
    getChain: async (chainId: string) => chains[chainId],
    getChainVmType: jest.fn().mockImplementation(async (chainId) => {
      if (chainId === "ethereum") return "ethereum-vm";
      if (chainId === "solana") return "solana-vm";
      if (chainId === "base") return "ethereum-vm";
      throw new Error(`Unknown chain: ${chainId}`);
    }),
    getChainHubChainId: jest.fn().mockImplementation(async (chainId) => {
      if (chainId === "ethereum") return 1;
      if (chainId === "solana") return 101;
      if (chainId === "base") return 8543;
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
      depositAddressManagerAddress:
        "0x0000000000000000000000000000000000000008",
      auroraHttpRpcUrl: "http://localhost:8545",
      auroraEvmChainId: "1313161554",
      auroraAllocatorAddress: "0x0000000000000000000000000000000000000005",
      auroraAllocatorSpenderAddress: "0x0000000000000000000000000000000000000006",
      auroraOracleMultisigAddress: "0x0000000000000000000000000000000000000007",
    })),
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

  describe("attestNonceMappingSignature", () => {
    const wallet = "0x1234567890123456789012345678901234567890";
    const nonce = "1";
    const id = keccak256("0x1234" as Hex);
    const signatureChainId = "ethereum";
    const walletChainId = "ethereum";
    const mockSignature = "0x" + "ab".repeat(65);

    it("returns correct generic mapping for valid signature", async () => {
      const result = await service.attestNonceMappingSignature({
        walletChainId,
        wallet,
        nonce,
        id,
        signatureChainId,
        signature: mockSignature,
      });

      const expectedUser = generateAddress({
        family: "ethereum-vm",
        chainId: "ethereum",
        address: wallet,
      });

      const expectedGenericMapping = getNonceMappingMessage(
        expectedUser,
        nonce,
        id,
      );

      expect(result.genericMapping).toEqual(expectedGenericMapping);
      expect(result.genericMapping.user).toBe(expectedUser);
      expect(result.genericMapping.data).toBe(id);
    });

    it("verifies the typed data signature with correct parameters", async () => {
      const mockedVerifyTypedData = jest.mocked(verifyTypedData);

      await service.attestNonceMappingSignature({
        walletChainId,
        wallet,
        nonce,
        id,
        signatureChainId,
        signature: mockSignature,
      });

      expect(mockedVerifyTypedData).toHaveBeenCalledWith({
        address: wallet,
        domain: {
          name: "RelayNonceMapping",
          version: "1",
          chainId: 1, // hubChainId for "ethereum"
          verifyingContract: "0x0000000000000000000000000000000000000000",
        },
        types: {
          NonceMapping: [
            { name: "chainId", type: "string" },
            { name: "wallet", type: "address" },
            { name: "id", type: "bytes32" },
            { name: "nonce", type: "uint256" },
          ],
        },
        primaryType: "NonceMapping",
        message: {
          chainId: walletChainId,
          wallet,
          id,
          nonce: BigInt(nonce),
        },
        signature: mockSignature,
      });
    });

    it("throws on invalid signature", async () => {
      const mockedVerifyTypedData = jest.mocked(verifyTypedData);
      mockedVerifyTypedData.mockResolvedValueOnce(false);

      await expect(
        service.attestNonceMappingSignature({
          walletChainId,
          wallet,
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
          nonce,
          id,
          signatureChainId: "solana",
          signature: mockSignature,
        }),
      ).rejects.toThrow("Unsupported signature chain");
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

  describe("attestWithdrawRequest", () => {
    const withdrawRequestInput = {
      chainId: "ethereum",
      depository: depositoryAddress,
      currency: "0x1111111111111111111111111111111111111111",
      amount: "1000",
      spenderChainId: "ethereum",
      spender: owner,
      receiver: "0xf70da97812cb96acdf810712aa562db8dfa3dbef",
      nonce: "0x0000000000000000000000000000000000000000000000000000000000000001",
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

      const result = await service.attestWithdrawRequest(
        withdrawRequestInput,
      );

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
        slippageBps: "50",
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
          ((BigInt(depositAmount) - BigInt(orderAmount)) * 10n ** 18n) /
            BigInt(orderAmount)) /
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
      ).rejects.toThrow(
        "Insufficient balance at order address for recovery",
      );
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

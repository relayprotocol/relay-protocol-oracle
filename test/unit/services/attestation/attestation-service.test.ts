import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { zeroHash, keccak256, encodePacked, Hex } from "viem";

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
  getWithdrawalAddress,
  getOrderId,
  Order,
  generateTokenId,
  generateAddress,
} from "@relay-protocol/settlement-sdk";

import {
  Chain,
  getChainHubChainId,
  getChainVmType,
  getSdkChainsConfig,
} from "../../../../src/common/chains";
import { createMockWithdrawalAddressRequest } from "../../../common/withdrawals";
import { getAddress } from "viem";

// default vars
const owner = "0x1234567890123456789012345678901234567890";
const ownerChainId = "ethereum";
const depositoryAddress = "0x0987654321098765432109876543210987654321";
const solanaDepositoryAddress = "FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u";

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
        mockMessage.data.transactionId
      );

      const hubTokenId = generateTokenId({
        address: mockMessage.result.currency,
        chainId: await getChainHubChainId(mockMessage.data.chainId),
        family: await getChainVmType(mockMessage.data.chainId),
      });

      const expectedHubToAddress = generateAddress({
        address: depositor,
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
          hubToAddress: expectedHubToAddress,
          amount: mockMessage.result.amount,
        },
      });

      // check mocks calls
      expect(getChainHubChainId).toHaveBeenCalledWith(mockMessage.data.chainId);
      expect(getChainVmType).toHaveBeenCalledWith(mockMessage.data.chainId);
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
        chainId: await getChainHubChainId(ownerChainId),
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
        "ethereum-vm"
      );
      const actualCurrency = getDecodedWithdrawalCurrency(
        actualDecodedWithdrawal
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
        depositoryChainId: BigInt(1),
        currency: withdrawalAddressRequestWithCurrency.currency,
        withdrawerAlias: withdrawalAddressRequestWithCurrency.withdrawerAlias,
        recipient: withdrawalAddressRequest.recipient,
        withdrawalNonce: withdrawalAddressRequestWithCurrency.withdrawalNonce,
      });

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
        chainId: await getChainHubChainId(ownerChainId),
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
        "ethereum-vm"
      );
      const actualCurrency = getDecodedWithdrawalCurrency(
        actualDecodedWithdrawal
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
        depositoryChainId: BigInt(1),
        currency: withdrawalAddressRequestWithCurrency.currency,
        withdrawerAlias: withdrawalAddressRequestWithCurrency.withdrawerAlias,
        recipient: withdrawalAddressRequest.recipient,
        withdrawalNonce: withdrawalAddressRequestWithCurrency.withdrawalNonce,
      });

      const result = await service.attestDepositoryWithdrawal(requestBody);
      const idempotencyKey = getDeterministicId(
        mockMessage.result.withdrawalId,
        requestBody.transactionId!,
        DepositoryWithdrawalStatus.EXPIRED.toString()
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
        actualDecodedWithdrawal
      );

      const solanaWithdrawalAddressRequest = createMockWithdrawalAddressRequest(
        {
          chainId: "solana",
          currency: actualCurrency,
          withdrawer: owner,
          withdrawerChainId: ownerChainId,
        }
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

      const withdrawerAlias = generateAddress({
        address: owner,
        chainId: await getChainHubChainId(ownerChainId),
        family: await getChainVmType(ownerChainId),
      });

      const withdrawalAddress = getWithdrawalAddress({
        depository: solanaDepositoryAddress,
        depositoryChainId: BigInt(101),
        currency: solanaWithdrawalAddressRequest.currency,
        withdrawerAlias,
        recipient: solanaWithdrawalAddressRequest.recipient,
        withdrawalNonce: solanaWithdrawalAddressRequest.withdrawalNonce,
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
          hubFromAddress: getAddress(withdrawalAddress),
          amount,
        },
      });
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
      expect(result.execution?.idempotencyKey).toBe(orderId);
      expect(result.execution?.actions.length).toBeGreaterThan(0);

      // TRANSFER actions from order to solver
      const hubTokenId = generateTokenId({
        address: currency,
        chainId: await getChainHubChainId("ethereum"),
        family: await getChainVmType("ethereum"),
      });

      const solverAlias = generateAddress({
        address: solverAddress,
        chainId: await getChainHubChainId("ethereum"),
        family: await getChainVmType("ethereum"),
      });

      // miror _getOrderAddress
      const orderHash = keccak256(
        encodePacked(
          ["string", "uint256", "uint256", "string", "bytes32"],
          [
            await getChainVmType("ethereum"),
            BigInt(await getChainHubChainId("ethereum")),
            BigInt(timestamp),
            depositor,
            orderId as Hex,
          ]
        )
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
          expectedOrderAddress.toLowerCase()
        );
        expect(decodedFirstAction.data.hubToAddress).toBe(solverAlias);
        expect(decodedFirstAction.data.amount).toBe(
          order.output.payments[0].expectedAmount
        );
      }
    });
  });
});

import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { AttestationService } from "../../../../src/services/attestation";
import { getVmAttestor } from "../../../../src/services/attestation/vm";
import { getDeterministicId } from "../../../../src/services/attestation/vm/utils";
import { ActionType, decodeAction } from "@reservoir0x/relay-protocol-sdk";
import {
  getChainHubChainId,
  getChainVmType,
} from "../../../../src/common/chains";
import { generateTokenId } from "@relay-protocol/hub-utils";

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

const mockGetVmAttestor = jest.mocked(getVmAttestor);

describe("AttestationService", () => {
  const service = new AttestationService();

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock chain configuration functions
    const {
      getSdkChainsConfig,
      getChainHubChainId,
      getChainVmType,
    } = require("../../../../src/common/chains");
    getSdkChainsConfig.mockResolvedValue({ ethereum: "ethereum-vm" });
    getChainHubChainId.mockResolvedValue(BigInt("1"));
    getChainVmType.mockResolvedValue("ethereum-vm");
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
});

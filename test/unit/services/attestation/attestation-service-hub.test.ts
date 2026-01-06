import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { AttestationService } from "../../../../src/services/attestation";
import { getHubAttestor } from "../../../../src/services/attestation/vm";
import { HubVmAttestor } from "../../../../src/services/attestation/vm/hub-vm";
import {
  ActionType,
  decodeAction,
  getWithdrawalAddress,
  generateAddress,
  generateTokenId,
} from "@relay-protocol/settlement-sdk";
import { encodePacked, getAddress } from "viem";
import { getDeterministicId } from "../../../../src/services/attestation/vm/utils";
import {
  Chain,
  getChainHubChainId,
  getChainVmType,
} from "../../../../src/common/chains";
import { createMockWithdrawalAddressRequest } from "../../../common/withdrawals";
import { getHubBlockNumber } from "../../../../src/common/vm/hub-vm/rpc";

jest.mock("../../../../src/services/attestation/vm");
jest.mock("../../../../src/common/chains");
jest.mock("../../../../src/common/vm/hub-vm/rpc");

const depositoryAddress = "0x0987654321098765432109876543210987654321";

jest.mock("../../../../src/common/chains", () => {
  const depositoryAddress = "0x0987654321098765432109876543210987654321";
  const chains: Record<string, Chain> = {
    ethereum: {
      id: "ethereum",
      vmType: "ethereum-vm",
      httpRpcUrl: "http://127.0.0.1:8545",
      depository: depositoryAddress,
      hubChainId: "ethereum",
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
    getChains: async () => chains,
    getChain: async (chainId: string) => chains[chainId],
    getChainVmType: jest.fn().mockImplementation(
      // @ts-expect-error - jest mock type inference issue
      async () => "ethereum-vm" as jest.MockedFunction<typeof getChainVmType>
    ),
    getChainHubChainId: jest
      .fn()
      .mockImplementation(async () => 1) as jest.MockedFunction<
      typeof getChainHubChainId
    >,
  };
});

const mockGetHubAttestor = jest.mocked(getHubAttestor) as jest.MockedFunction<
  typeof getHubAttestor
>;
const mockGetHubBlockNumber = jest.mocked(
  getHubBlockNumber
) as jest.MockedFunction<typeof getHubBlockNumber>;

describe("HubAttestationService - attestWithdrawalAddressBalance", () => {
  const service = new AttestationService();

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetHubBlockNumber.mockResolvedValue(12345n);
  });

  it("should successfully attest withdrawal address balance with sufficient funds", async () => {
    const ownerAddress = "0x1234567890123456789012345678901234567890";
    const ownerChainId = "ethereum";

    // the alias for withdrawer address on origin chain
    const withdrawerAlias = generateAddress({
      address: ownerAddress,
      chainId: await getChainHubChainId(ownerChainId),
      family: await getChainVmType(ownerChainId),
    });

    const withdrawalAddressRequest = createMockWithdrawalAddressRequest({
      chainId: "ethereum",
      amount: "1000000000000000000", // 1 ETH
      withdrawerAlias,
    });

    const requestBody = {
      settlementChainId: "arbitrum-sepolia",
      ...withdrawalAddressRequest,
    };

    const recipientAlias = generateAddress({
      address: withdrawalAddressRequest.recipient,
      chainId: await getChainHubChainId(withdrawalAddressRequest.chainId),
      family: await getChainVmType(withdrawalAddressRequest.chainId),
    });

    const depositoryAlias = generateAddress({
      address: depositoryAddress,
      chainId: await getChainHubChainId(withdrawalAddressRequest.chainId),
      family: await getChainVmType(withdrawalAddressRequest.chainId),
    });

    const withdrawalAddress = getWithdrawalAddress({
      depository: depositoryAlias,
      depositoryChainId: BigInt(1),
      currency: withdrawalAddressRequest.currency,
      withdrawerAlias,
      recipient: recipientAlias,
      amount: BigInt(withdrawalAddressRequest.amount),
      withdrawalNonce: withdrawalAddressRequest.withdrawalNonce,
    });

    const fundedAmount = "2000000000000000000"; // 2 ETH - sufficient
    const blockNumber = 12345n;

    const mockHubAttestor = {
      getBalanceOnHub: jest.fn<any>().mockResolvedValue(fundedAmount),
    } as unknown as HubVmAttestor;

    mockGetHubAttestor.mockResolvedValue(mockHubAttestor);
    mockGetHubBlockNumber.mockResolvedValue(blockNumber);

    const result = await service.attestWithdrawalAddressBalance(requestBody);

    // Compute expected proof (address, balance, blockNumber)
    const expectedProof = encodePacked(
      ["address", "uint256", "uint256"],
      [withdrawalAddress as `0x${string}`, BigInt(fundedAmount), blockNumber]
    );

    expect(result.message.data).toEqual(requestBody);
    expect(result.message.result.proofOfWithdrawalAddressBalance).toBe(
      expectedProof
    );
    expect(mockHubAttestor.getBalanceOnHub).toHaveBeenCalledWith(
      requestBody.settlementChainId,
      withdrawalAddress,
      expect.any(BigInt)
    );
    expect(mockGetHubBlockNumber).toHaveBeenCalledWith(
      requestBody.settlementChainId
    );
  });

  it("should throw error when balance is insufficient", async () => {
    const ownerAddress = "0x1234567890123456789012345678901234567890";
    const ownerChainId = "ethereum";

    // the alias for withdrawer address on origin chain
    const withdrawerAlias = generateAddress({
      address: ownerAddress,
      chainId: await getChainHubChainId(ownerChainId),
      family: await getChainVmType(ownerChainId),
    });

    const withdrawalAddressRequest = createMockWithdrawalAddressRequest({
      chainId: "ethereum",
      amount: "2000000000000000000", // 2 ETH
      withdrawerAlias,
    });

    const requestBody = {
      settlementChainId: "sovereign-testnet",
      ...withdrawalAddressRequest,
    };

    const mockHubAttestor = {
      getBalanceOnHub: jest.fn<any>().mockResolvedValue("1000000000000000000"), // 1 ETH - insufficient
    } as unknown as HubVmAttestor;

    mockGetHubAttestor.mockResolvedValue(mockHubAttestor);

    await expect(
      service.attestWithdrawalAddressBalance(requestBody)
    ).rejects.toThrow("Insufficient withdrawal address balance");
  });
});

describe("HubAttestationService - attestWithdrawerBalance", () => {
  const service = new AttestationService();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should successfully attest withdrawer balance with sufficient funds", async () => {
    const ownerAddress = "0x1234567890123456789012345678901234567890";
    const ownerChainId = "ethereum";

    // the alias for withdrawer address on origin chain
    const withdrawerAlias = generateAddress({
      address: ownerAddress,
      chainId: await getChainHubChainId(ownerChainId),
      family: await getChainVmType(ownerChainId),
    });

    const withdrawalAddressRequest = createMockWithdrawalAddressRequest({
      chainId: "ethereum",
      amount: "1000000000000000000", // 1 ETH
      withdrawerAlias,
    });

    const requestBody = {
      settlementChainId: "sovereign-testnet",
      ...withdrawalAddressRequest,
    };

    const depositoryAlias = generateAddress({
      address: depositoryAddress,
      chainId: await getChainHubChainId(withdrawalAddressRequest.chainId),
      family: await getChainVmType(withdrawalAddressRequest.chainId),
    });

    const recipientAlias = generateAddress({
      address: withdrawalAddressRequest.recipient,
      chainId: await getChainHubChainId(withdrawalAddressRequest.chainId),
      family: await getChainVmType(withdrawalAddressRequest.chainId),
    });

    const withdrawalAddress = getWithdrawalAddress({
      depository: depositoryAlias,
      depositoryChainId: BigInt(1),
      currency: withdrawalAddressRequest.currency,
      withdrawerAlias,
      recipient: recipientAlias,
      amount: BigInt(withdrawalAddressRequest.amount),
      withdrawalNonce: withdrawalAddressRequest.withdrawalNonce,
    });

    const mockHubAttestor = {
      getBalanceOnHub: jest.fn<any>().mockResolvedValue("2000000000000000000"), // 2 ETH - sufficient
    } as unknown as HubVmAttestor;

    mockGetHubAttestor.mockResolvedValue(mockHubAttestor);

    const result = await service.attestWithdrawalOwnerBalance(requestBody);

    expect(result.message.data).toEqual(requestBody);
    expect(result.message.result.withdrawalAddress).toBe(withdrawalAddress);
    expect(mockHubAttestor.getBalanceOnHub).toHaveBeenCalledWith(
      requestBody.settlementChainId,
      withdrawerAlias,
      expect.any(BigInt)
    );
  });

  it("should throw error when balance is insufficient", async () => {
    const withdrawalAddressRequest = createMockWithdrawalAddressRequest({
      chainId: "ethereum",
      amount: "2000000000000000000", // 2 ETH
    });

    const requestBody = {
      settlementChainId: "sovereign-testnet",
      ...withdrawalAddressRequest,
    };

    const mockHubAttestor = {
      getBalanceOnHub: jest.fn<any>().mockResolvedValue("1000000000000000000"), // 1 ETH - insufficient
    } as unknown as HubVmAttestor;

    mockGetHubAttestor.mockResolvedValue(mockHubAttestor);

    await expect(
      service.attestWithdrawalOwnerBalance(requestBody)
    ).rejects.toThrow("Insufficient initial withdrawal balance");
  });

  it("should include execution", async () => {
    const depositoryAddress = "0x0987654321098765432109876543210987654321";
    const ownerAddress = "0x1234567890123456789012345678901234567890";
    const ownerChainId = "ethereum";

    // the alias for withdrawer address on origin chain
    const withdrawerAlias = generateAddress({
      address: ownerAddress,
      chainId: await getChainHubChainId(ownerChainId),
      family: await getChainVmType(ownerChainId),
    });

    const withdrawalAddressRequest = createMockWithdrawalAddressRequest({
      chainId: "ethereum",
      amount: "1000000000000000000", // 1 ETH
      withdrawerAlias,
    });

    const requestBody = {
      settlementChainId: "sovereign-testnet",
      ...withdrawalAddressRequest,
    };

    const fundedAmount = "2000000000000000000"; // 2 ETH
    const mockHubAttestor = {
      getBalanceOnHub: jest.fn<any>().mockResolvedValue(fundedAmount),
    } as unknown as HubVmAttestor;

    mockGetHubAttestor.mockResolvedValue(mockHubAttestor);

    const result = await service.attestWithdrawalOwnerBalance(requestBody);

    const depositoryAlias = generateAddress({
      address: depositoryAddress,
      chainId: await getChainHubChainId(withdrawalAddressRequest.chainId),
      family: await getChainVmType(withdrawalAddressRequest.chainId),
    });

    const recipientAlias = generateAddress({
      address: withdrawalAddressRequest.recipient,
      chainId: await getChainHubChainId(withdrawalAddressRequest.chainId),
      family: await getChainVmType(withdrawalAddressRequest.chainId),
    });

    const withdrawalAddress = getWithdrawalAddress({
      depository: depositoryAlias,
      depositoryChainId: BigInt(1),
      currency: withdrawalAddressRequest.currency,
      withdrawerAlias,
      recipient: recipientAlias,
      amount: BigInt(withdrawalAddressRequest.amount),
      withdrawalNonce: withdrawalAddressRequest.withdrawalNonce,
    });
    const hubTokenId = generateTokenId({
      address: withdrawalAddressRequest.currency,
      chainId: await getChainHubChainId("1"),
      family: await getChainVmType("1"),
    });
    const idempotencyKey = getDeterministicId(
      requestBody.settlementChainId,
      hubTokenId.toString(),
      withdrawalAddress
    );

    expect(result.execution).toBeDefined();
    expect(result.execution?.idempotencyKey).toBe(idempotencyKey);
    expect(result.execution?.actions.length).toBe(1);

    const [action] = result.execution?.actions || [];
    expect(decodeAction(action)).toEqual({
      type: ActionType.TRANSFER,
      data: {
        hubTokenId,
        hubFromAddress: withdrawerAlias,
        hubToAddress: getAddress(withdrawalAddress),
        amount: fundedAmount,
      },
    });
  });
});

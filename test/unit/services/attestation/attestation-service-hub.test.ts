import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { AttestationService } from "../../../../src/services/attestation";
import { getHubAttestor } from "../../../../src/services/attestation/vm";
import { HubVmAttestor } from "../../../../src/services/attestation/vm/hub-vm";
import { ActionType, decodeAction } from "@reservoir0x/relay-protocol-sdk";
import { getWithdrawalAddress } from "@reservoir0x/relay-protocol-sdk";
import { encodePacked, getAddress } from "viem";
import { generateAddress, generateTokenId } from "@relay-protocol/hub-utils";
import { getDeterministicId } from "../../../../src/services/attestation/vm/utils";
import {
  getChainHubChainId,
  getChainVmType,
} from "../../../../src/common/chains";
import { createMockWithdrawalAddressRequest } from "../../../common/withdrawals";
import { getHubBlockNumber } from "../../../../src/common/vm/hub-vm/rpc";

jest.mock("../../../../src/services/attestation/vm");
jest.mock("../../../../src/common/chains");
jest.mock("../../../../src/common/vm/hub-vm/rpc");

jest.mock("../../../../src/common/chains", () => ({
  getChainVmType: jest.fn().mockImplementation(
    // @ts-expect-error - jest mock type inference issue
    async () => "ethereum-vm" as jest.MockedFunction<typeof getChainVmType>
  ),
  getChainHubChainId: jest
    .fn()
    .mockImplementation(async () => 1) as jest.MockedFunction<
    typeof getChainHubChainId
  >,
}));

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
    const withdrawalAddressRequest = createMockWithdrawalAddressRequest({
      depositoryChainSlug: "1",
      amount: "1000000000000000000", // 1 ETH
    });

    const requestBody = {
      settlementChainId: "1",
      ...withdrawalAddressRequest,
    };

    // the alias for withdrawer address on origin chain
    const withdrawerAlias = generateAddress({
      address: withdrawalAddressRequest.owner,
      chainId: await getChainHubChainId(withdrawalAddressRequest.ownerChainId),
      family: await getChainVmType(withdrawalAddressRequest.ownerChainId),
    });

    const withdrawalAddress = getWithdrawalAddress({
      depositoryAddress: withdrawalAddressRequest.depositoryAddress,
      depositoryChainId: BigInt(1),
      currency: withdrawalAddressRequest.currency,
      owner: withdrawerAlias,
      ownerChainId: withdrawalAddressRequest.ownerChainId,
      recipientAddress: withdrawalAddressRequest.recipientAddress,
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
    const withdrawalAddressRequest = createMockWithdrawalAddressRequest({
      depositoryChainSlug: "1",
      amount: "2000000000000000000", // 2 ETH
    });

    const requestBody = {
      settlementChainId: "1",
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
    const withdrawalAddressRequest = createMockWithdrawalAddressRequest({
      depositoryChainSlug: "1",
      amount: "1000000000000000000", // 1 ETH
    });

    const requestBody = {
      settlementChainId: "1",
      ...withdrawalAddressRequest,
    };

    // the alias for withdrawer address on origin chain
    const withdrawerAlias = generateAddress({
      address: withdrawalAddressRequest.owner,
      chainId: await getChainHubChainId(withdrawalAddressRequest.ownerChainId),
      family: await getChainVmType(withdrawalAddressRequest.ownerChainId),
    });

    const withdrawalAddress = getWithdrawalAddress({
      depositoryAddress: withdrawalAddressRequest.depositoryAddress,
      depositoryChainId: BigInt(1),
      currency: withdrawalAddressRequest.currency,
      owner: withdrawerAlias,
      ownerChainId: withdrawalAddressRequest.ownerChainId,
      recipientAddress: withdrawalAddressRequest.recipientAddress,
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
    expect(result.execution).toBeUndefined();
    expect(mockHubAttestor.getBalanceOnHub).toHaveBeenCalledWith(
      requestBody.settlementChainId,
      withdrawerAlias,
      expect.any(BigInt)
    );
  });

  it("should throw error when balance is insufficient", async () => {
    const withdrawalAddressRequest = createMockWithdrawalAddressRequest({
      depositoryChainSlug: "1",
      amount: "2000000000000000000", // 2 ETH
    });

    const requestBody = {
      settlementChainId: "1",
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

  it("should include execution (when includeOnchainHubExecution = true)", async () => {
    const withdrawalAddressRequest = createMockWithdrawalAddressRequest({
      depositoryChainSlug: "1",
      amount: "1000000000000000000", // 1 ETH
    });

    const requestBody = {
      settlementChainId: "1",
      ...withdrawalAddressRequest,
      includeOnchainHubExecution: true,
    };

    const fundedAmount = "2000000000000000000"; // 2 ETH
    const mockHubAttestor = {
      getBalanceOnHub: jest.fn<any>().mockResolvedValue(fundedAmount),
    } as unknown as HubVmAttestor;

    mockGetHubAttestor.mockResolvedValue(mockHubAttestor);

    const result = await service.attestWithdrawalOwnerBalance(requestBody);

    // the alias for withdrawer address on origin chain
    const withdrawerAlias = generateAddress({
      address: withdrawalAddressRequest.owner,
      chainId: await getChainHubChainId(withdrawalAddressRequest.ownerChainId),
      family: await getChainVmType(withdrawalAddressRequest.ownerChainId),
    });

    const withdrawalAddress = getWithdrawalAddress({
      depositoryAddress: withdrawalAddressRequest.depositoryAddress,
      depositoryChainId: BigInt(1),
      currency: withdrawalAddressRequest.currency,
      owner: withdrawerAlias,
      ownerChainId: withdrawalAddressRequest.ownerChainId,
      recipientAddress: withdrawalAddressRequest.recipientAddress,
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

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
  computeWithdrawerBalanceMessage,
} from "@relay-protocol/settlement-sdk";
import { encodePacked, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createHash } from "crypto";

import { getDeterministicId } from "../../../../src/services/attestation/vm/utils";
import {
  Chain,
  getChainHubChainId,
  getChainVmType,
} from "../../../../src/common/chains";

// test helpers
import {
  createMockWithdrawalAddressRequest,
  randomBytes32,
} from "../../../common/withdrawals";

const ownerChainId = "ethereum";
const depositoryAddress = "0x0987654321098765432109876543210987654321";

// private key for testing
const TEST_PRIVATE_KEY =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const account = privateKeyToAccount(TEST_PRIVATE_KEY as `0x${string}`);
const ownerAddress = account.address;

export async function sign(message: string) {
  const hash = createHash("sha256").update(message).digest("hex");

  // sign raw bytes (without Ethereum message prefix)
  const signature = await account.signMessage({
    message: {
      raw: `0x${hash}` as `0x${string}`,
    },
  });

  return signature;
}

jest.mock("../../../../src/services/attestation/vm");
jest.mock("../../../../src/common/chains");
jest.mock("../../../../src/common/vm/hub-vm/rpc");

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

describe("HubAttestationService - attestWithdrawalAddressBalance", () => {
  const service = new AttestationService();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should successfully attest withdrawal address balance with sufficient funds", async () => {
    // the alias for withdrawer address on origin chain
    const withdrawerAlias = generateAddress({
      address: ownerAddress,
      chainId: await getChainHubChainId(ownerChainId),
      family: await getChainVmType(ownerChainId),
    });

    const withdrawalAddressRequest = createMockWithdrawalAddressRequest({
      chainId: "ethereum",
      withdrawer: ownerAddress,
      withdrawerChainId: ownerChainId,
    });

    const expectedAmount = "1000000000000000000"; // 1 ETH
    const requestBody = {
      settlementChainId: "arbitrum-sepolia",
      expectedAmount,
      ...withdrawalAddressRequest,
    };

    const withdrawalAddress = getWithdrawalAddress({
      depository: depositoryAddress!,
      depositoryChainId: BigInt(1),
      currency: withdrawalAddressRequest.currency,
      withdrawerAlias,
      recipient: withdrawalAddressRequest.recipient,
      withdrawalNonce: withdrawalAddressRequest.withdrawalNonce,
    });

    const fundedAmount = "2000000000000000000"; // 2 ETH - sufficient

    const mockHubAttestor = {
      getBalanceOnHub: jest.fn<any>().mockResolvedValue(fundedAmount),
    } as unknown as HubVmAttestor;

    mockGetHubAttestor.mockResolvedValue(mockHubAttestor);

    const result = await service.attestWithdrawalAddressBalance(requestBody);

    // Compute expected proof (address, balance, blockNumber)
    const expectedProof = encodePacked(
      ["address", "uint256", "bytes32"],
      [
        withdrawalAddress as `0x${string}`,
        BigInt(expectedAmount),
        withdrawalAddressRequest.withdrawalNonce as `0x${string}`,
      ]
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
  });

  it("should throw error when balance is insufficient", async () => {
    const withdrawalAddressRequest = createMockWithdrawalAddressRequest({
      chainId: "ethereum",
      withdrawer: ownerAddress,
      withdrawerChainId: ownerChainId,
    });

    const requestBody = {
      settlementChainId: "sovereign-testnet",
      expectedAmount: "2000000000000000000", // 2 ETH
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
    // the alias for withdrawer address on origin chain
    const withdrawerAlias = generateAddress({
      address: ownerAddress,
      chainId: await getChainHubChainId(ownerChainId),
      family: await getChainVmType(ownerChainId),
    });

    const amount = "1000000000000000000"; // 1 ETH
    const withdrawalNonce = randomBytes32();
    const withdrawalAddressRequest = createMockWithdrawalAddressRequest({
      chainId: "ethereum",
      withdrawer: ownerAddress,
      withdrawerChainId: ownerChainId,
      withdrawalNonce,
    });

    const hash = computeWithdrawerBalanceMessage(
      withdrawerAlias,
      BigInt(amount),
      withdrawalNonce
    );

    const signature = await sign(hash);

    const requestBody = {
      settlementChainId: "sovereign-testnet",
      expectedAmount: amount,
      ...withdrawalAddressRequest,
      signature,
    };

    const withdrawalAddress = getWithdrawalAddress({
      depository: depositoryAddress!,
      depositoryChainId: BigInt(1),
      currency: withdrawalAddressRequest.currency,
      withdrawerAlias,
      recipient: withdrawalAddressRequest.recipient,
      withdrawalNonce: withdrawalAddressRequest.withdrawalNonce,
    });

    const mockHubAttestor = {
      getBalanceOnHub: jest.fn<any>().mockResolvedValue("2000000000000000000"), // 2 ETH - sufficient
    } as unknown as HubVmAttestor;

    mockGetHubAttestor.mockResolvedValue(mockHubAttestor);

    const result = await service.attestWithdrawerBalance(requestBody);

    expect(result.message.data).toEqual(requestBody);
    expect(result.message.result.withdrawalAddress).toBe(withdrawalAddress);
    expect(mockHubAttestor.getBalanceOnHub).toHaveBeenCalledWith(
      requestBody.settlementChainId,
      withdrawerAlias,
      expect.any(BigInt)
    );
  });

  it("should throw error when balance is insufficient", async () => {
    const amount = "2000000000000000000"; // 1 ETH
    const withdrawalAddressRequest = createMockWithdrawalAddressRequest({
      chainId: "ethereum",
      withdrawer: ownerAddress,
      withdrawerChainId: ownerChainId,
    });

    // the alias for withdrawer address on origin chain
    const withdrawerAlias = generateAddress({
      address: ownerAddress,
      chainId: await getChainHubChainId(ownerChainId),
      family: await getChainVmType(ownerChainId),
    });

    const signedMessage = computeWithdrawerBalanceMessage(
      withdrawerAlias,
      BigInt(amount),
      withdrawalAddressRequest.withdrawalNonce
    );

    const signature = await sign(signedMessage);

    const requestBody = {
      settlementChainId: "sovereign-testnet",
      expectedAmount: amount,
      ...withdrawalAddressRequest,
      signature,
    };

    const mockHubAttestor = {
      getBalanceOnHub: jest.fn<any>().mockResolvedValue("1000000000000000000"), // 1 ETH - insufficient
    } as unknown as HubVmAttestor;

    mockGetHubAttestor.mockResolvedValue(mockHubAttestor);

    await expect(service.attestWithdrawerBalance(requestBody)).rejects.toThrow(
      "Insufficient initial withdrawal balance"
    );
  });

  it("should throw error if signature does not match withdrawer", async () => {
    const amount = "1000000000000000000"; // 1 ETH
    const withdrawalAddressRequest = createMockWithdrawalAddressRequest({
      chainId: "ethereum",
      withdrawer: "0x5143DcEaF7ceEAe6bf24E51c23b8e1EEe28f4241",
      withdrawerChainId: ownerChainId,
    });

    // the alias for withdrawer address on origin chain
    const withdrawerAlias = generateAddress({
      address: ownerAddress,
      chainId: await getChainHubChainId(ownerChainId),
      family: await getChainVmType(ownerChainId),
    });

    const signedMessage = computeWithdrawerBalanceMessage(
      withdrawerAlias,
      BigInt(amount),
      withdrawalAddressRequest.withdrawalNonce
    );

    const signature = await sign(signedMessage);

    const requestBody = {
      settlementChainId: "sovereign-testnet",
      expectedAmount: amount,
      ...withdrawalAddressRequest,
      signature,
    };

    const mockHubAttestor = {
      getBalanceOnHub: jest.fn<any>().mockResolvedValue("1000000000000000000"), // 1 ETH - insufficient
    } as unknown as HubVmAttestor;

    mockGetHubAttestor.mockResolvedValue(mockHubAttestor);

    await expect(service.attestWithdrawerBalance(requestBody)).rejects.toThrow(
      "Invalid signature"
    );
  });

  it("should include execution", async () => {
    const amount = "1000000000000000000";
    // the alias for withdrawer address on origin chain
    const withdrawerAlias = generateAddress({
      address: ownerAddress,
      chainId: await getChainHubChainId(ownerChainId),
      family: await getChainVmType(ownerChainId),
    });

    const withdrawalAddressRequest = createMockWithdrawalAddressRequest({
      chainId: "ethereum",
      withdrawer: ownerAddress,
      withdrawerChainId: ownerChainId,
    });

    const hash = computeWithdrawerBalanceMessage(
      withdrawerAlias,
      BigInt(amount),
      withdrawalAddressRequest.withdrawalNonce
    );

    const signature = await sign(hash);

    const requestBody = {
      settlementChainId: "sovereign-testnet",
      expectedAmount: amount, // 1 ETH
      ...withdrawalAddressRequest,
      signature,
    };

    const fundedAmount = "2000000000000000000"; // 2 ETH
    const mockHubAttestor = {
      getBalanceOnHub: jest.fn<any>().mockResolvedValue(fundedAmount),
    } as unknown as HubVmAttestor;

    mockGetHubAttestor.mockResolvedValue(mockHubAttestor);

    const result = await service.attestWithdrawerBalance(requestBody);

    const withdrawalAddress = getWithdrawalAddress({
      depository: depositoryAddress!,
      depositoryChainId: BigInt(1),
      currency: withdrawalAddressRequest.currency,
      withdrawerAlias,
      recipient: withdrawalAddressRequest.recipient,
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
        amount: requestBody.expectedAmount,
      },
    });
  });
});

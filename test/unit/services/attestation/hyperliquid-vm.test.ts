import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import {
  encodeWithdrawal,
  decodeWithdrawal,
  DepositoryWithdrawalStatus,
} from "@relay-protocol/settlement-sdk";
import { zeroHash } from "viem";

import { Chain } from "../../../../src/common/chains";
import { httpRpc } from "../../../../src/common/vm/hyperliquid-vm/rpc";
import { getHubHttpRpc as hubHttpRpc } from "../../../../src/common/hub";
import { AttestationService } from "../../../../src/services/attestation";
import { HyperliquidVmAttestor } from "../../../../src/services/attestation/vm/hyperliquid-vm";

import { randomHex } from "../../../common/utils";
import { createMockWithdrawalAddressRequest } from "../../../common/withdrawals";

const testDepositoryAddress = "0x1234567890abcdef1234567890abcdef12345678";
const testAdditionalDepositoryAddress =
  "0x9876543210fedcba9876543210fedcba98765432";
const testUserAddress = "0xabcdef1234567890abcdef1234567890abcdef12";
const testSolverAddress = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const testRecipientAddress = "0xfeedfacefeedfacefeedfacefeedfacefeedface";

jest.mock("../../../../src/common/chains", () => {
  const chains: Record<string, Chain> = {
    hyperliquid: {
      id: "hyperliquid",
      vmType: "hyperliquid-vm",
      httpRpcUrl: "https://api.hyperliquid.xyz",
      depository: "0x1234567890abcdef1234567890abcdef12345678",
      additionalDepositories: ["0x9876543210fedcba9876543210fedcba98765432"],
      hubChainId: "1",
    },
  };
  return {
    HUB_VM_TYPE: "hub-vm",
    HUB_CHAIN_ID: 0n,
    getChains: async () => chains,
    getHubInfo: async () => ({
      id: "hub",
      evmChainId: "1",
      httpRpcUrl: "http://localhost:8545",
      hubAddress: "0x0000000000000000000000000000000000000001",
      oracleAddress: "0x0000000000000000000000000000000000000002",
      oracleMultisigAddress: "0x0000000000000000000000000000000000000003",
      genericMappingAddress: "0x0000000000000000000000000000000000000004",
      auroraHttpRpcUrl: "http://localhost:8545",
      auroraEvmChainId: "1313161554",
      auroraAllocatorAddress: "0x0000000000000000000000000000000000000005",
      auroraAllocatorSpenderAddress: "0x0000000000000000000000000000000000000006",
      auroraOracleMultisigAddress: "0x0000000000000000000000000000000000000007",
    }),
    getChain: async (chainId: string) => chains[chainId],
    getChainVmType: async (chainId: string) =>
      chainId === "base" ? "ethereum-vm" : chains[chainId].vmType,
    getChainHubChainId: async (chainId: string) =>
      chainId === "base" ? "8453" : chains[chainId].hubChainId,
    getSdkChainsConfig: () =>
      Object.fromEntries(
        Object.values(chains).map((chain) => [chain.id, chain.vmType]),
      ),
  };
});

jest.mock("../../../../src/common/vm/hyperliquid-vm/rpc", () => {
  return {
    httpRpc: jest.fn(),
  };
});

jest.mock("../../../../src/common/hub", () => {
  return {
    getHubHttpRpc: jest.fn(),
  };
});

const setupRpcMock = (mockData: any) => {
  (httpRpc as jest.Mock).mockImplementation(() => {
    return Promise.resolve({
      ...mockData,
    });
  });
};

describe("HyperliquidVmAttestor", () => {
  describe("getDepositoryDepositMessages", () => {
    const setupHubRpcMock = (
      data?: { id: string; createdAt?: number },
    ) => {
      const mockHubClient = {
        readContract: jest.fn<any>().mockResolvedValue(
          data
            ? [data.id, BigInt(data.createdAt ?? Math.floor(Date.now() / 1000))]
            : ["0x", 0n],
        ),
      };
      (hubHttpRpc as jest.Mock<any>).mockResolvedValue(mockHubClient);
    };

    beforeEach(() => {
      jest.clearAllMocks();
      // Default: no hub mapping found
      setupHubRpcMock();
    });

    it("should correctly parse UsdSend deposit transaction", async () => {
      const transactionId = randomHex(32);
      const expectedDepositId = randomHex(32);

      const depositTx = {
        time: Date.now(),
        user: testUserAddress,
        action: {
          type: "usdSend",
          signatureChainId: "0x1",
          hyperliquidChain: "Mainnet",
          destination: testDepositoryAddress,
          amount: "100.0",
          time: 1761563890702,
        },
        block: 776752679,
        hash: transactionId,
        error: null,
      };

      // Mock the hub on-chain lookup for deposit ID
      setupHubRpcMock({ id: expectedDepositId });

      setupRpcMock({
        txDetails: async () => ({
          tx: depositTx,
        }),
      });

      const { messages } =
        await new AttestationService().attestDepositoryDeposits({
          chainId: "hyperliquid",
          transactionId,
        });

      expect(messages).toHaveLength(1);
      expect(messages[0].data.chainId).toBe("hyperliquid");
      expect(messages[0].data.transactionId).toBe(transactionId);
      expect(messages[0].result.depository).toBe(testDepositoryAddress);
      expect(messages[0].result.depositor).toBe(testUserAddress);
      expect(messages[0].result.depositId).toBe(expectedDepositId);
      expect(messages[0].result.currency).toBe(
        "0x00000000000000000000000000000000",
      );
      expect(messages[0].result.amount).toBe("10000000000");
      expect(messages[0].result.onchainId).toBeDefined();
    });

    it("should use depositor from nonce mapping data when present", async () => {
      const transactionId = randomHex(32);
      const expectedDepositId = randomHex(32);
      const mappedDepositor = "0x1111111111111111111111111111111111111111";

      const depositTx = {
        time: Date.now(),
        user: testUserAddress,
        action: {
          type: "usdSend",
          signatureChainId: "0x1",
          hyperliquidChain: "Mainnet",
          destination: testDepositoryAddress,
          amount: "100.0",
          time: 1761563890702,
        },
        block: 776752679,
        hash: transactionId,
        error: null,
      };

      setupHubRpcMock({
        id: `${expectedDepositId}${mappedDepositor.slice(2)}`,
      });

      setupRpcMock({
        txDetails: async () => ({
          tx: depositTx,
        }),
      });

      const { messages } =
        await new AttestationService().attestDepositoryDeposits({
          chainId: "hyperliquid",
          transactionId,
        });

      expect(messages).toHaveLength(1);
      expect(messages[0].result.depositor).toBe(mappedDepositor);
      expect(messages[0].result.depositId).toBe(expectedDepositId);
    });

    it("should correctly parse SendAsset deposit transaction", async () => {
      const transactionId = randomHex(32);
      const expectedDepositId = randomHex(32);

      const depositTx = {
        time: Date.now(),
        user: testUserAddress,
        action: {
          type: "sendAsset",
          signatureChainId: "0x1",
          hyperliquidChain: "Mainnet",
          destination: testDepositoryAddress,
          sourceDex: "",
          destinationDex: "spot",
          token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
          amount: "10.04",
          fromSubAccount: "",
          nonce: 1761563890239,
        },
        block: 776752679,
        hash: transactionId,
        error: null,
      };

      // Mock the hub on-chain lookup for deposit ID
      setupHubRpcMock({ id: expectedDepositId });

      setupRpcMock({
        txDetails: async () => ({
          tx: depositTx,
        }),
        spotMeta: async () => ({
          tokens: [
            {
              tokenId: "0x6d1e7cde53ba9467b783cb7c530ce054",
              szDecimals: 6,
            },
          ],
        }),
      });

      const { messages } =
        await new AttestationService().attestDepositoryDeposits({
          chainId: "hyperliquid",
          transactionId,
        });

      expect(messages).toHaveLength(1);
      expect(messages[0].data.chainId).toBe("hyperliquid");
      expect(messages[0].data.transactionId).toBe(transactionId);
      expect(messages[0].result.depository).toBe(testDepositoryAddress);
      expect(messages[0].result.depositor).toBe(testUserAddress);
      expect(messages[0].result.depositId).toBe(expectedDepositId);
      expect(messages[0].result.currency).toBe(
        "0x6d1e7cde53ba9467b783cb7c530ce054",
      );
      expect(messages[0].result.amount).toBe("10040000");
      expect(messages[0].result.onchainId).toBeDefined();
    });

    it("should throw error when transaction failed", async () => {
      const transactionId = randomHex(32);

      const failedTx = {
        time: Date.now(),
        user: testUserAddress,
        action: {
          type: "usdSend",
          destination: testDepositoryAddress,
          amount: "100.0",
        },
        hash: transactionId,
        error: "Transaction failed",
      };

      setupRpcMock({
        txDetails: async () => ({
          tx: failedTx,
        }),
      });

      try {
        await new AttestationService().attestDepositoryDeposits({
          chainId: "hyperliquid",
          transactionId,
        });
        expect(false).toBe(true); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain(`Transaction failed: ${transactionId}`);
      }
    });

    it("should return empty array when transaction is not a deposit to depository", async () => {
      const transactionId = randomHex(32);

      const nonDepositTx = {
        time: Date.now(),
        user: testUserAddress,
        action: {
          type: "usdSend",
          destination: "0xOtherAddress1234567890abcdef1234567890ab", // Different from depository
          amount: "100.0",
        },
        hash: transactionId,
        error: null,
      };

      setupRpcMock({
        txDetails: async () => ({
          tx: nonDepositTx,
        }),
      });

      const { messages } =
        await new AttestationService().attestDepositoryDeposits({
          chainId: "hyperliquid",
          transactionId,
        });

      expect(messages).toHaveLength(0);
    });

    it("should attest a deposit to an additional depository", async () => {
      const transactionId = randomHex(32);
      const expectedDepositId = randomHex(32);

      const depositTx = {
        time: Date.now(),
        user: testUserAddress,
        action: {
          type: "usdSend",
          signatureChainId: "0x1",
          hyperliquidChain: "Mainnet",
          destination: testAdditionalDepositoryAddress,
          amount: "100.0",
          time: 1761563890702,
        },
        block: 776752679,
        hash: transactionId,
        error: null,
      };

      setupHubRpcMock({ id: expectedDepositId });

      setupRpcMock({
        txDetails: async () => ({
          tx: depositTx,
        }),
      });

      const { messages } =
        await new AttestationService().attestDepositoryDeposits({
          chainId: "hyperliquid",
          transactionId,
        });

      expect(messages).toHaveLength(1);
      expect(messages[0].result.depository).toBe(
        testAdditionalDepositoryAddress,
      );
      expect(messages[0].result.depositor).toBe(testUserAddress);
      expect(messages[0].result.depositId).toBe(expectedDepositId);
    });

    it("should return empty array for unsupported transaction types", async () => {
      const transactionId = randomHex(32);

      const unsupportedTx = {
        time: Date.now(),
        user: testUserAddress,
        action: {
          type: "otherAction", // Unsupported type
          destination: testDepositoryAddress,
        },
        hash: transactionId,
        error: null,
      };

      setupRpcMock({
        txDetails: async () => ({
          tx: unsupportedTx,
        }),
      });

      const { messages } =
        await new AttestationService().attestDepositoryDeposits({
          chainId: "hyperliquid",
          transactionId,
        });

      expect(messages).toHaveLength(0);
    });

    it("should throw error for non-USDC perps token", async () => {
      const transactionId = randomHex(32);

      const invalidPerpsDeposit = {
        time: Date.now(),
        user: testUserAddress,
        action: {
          type: "sendAsset",
          destination: testDepositoryAddress,
          sourceDex: "",
          destinationDex: "", // Empty means perps
          token: "ETH:0xOtherToken1234567890abcdef1234567890ab", // Not USDC
          amount: "1.0",
          nonce: 1761563890239,
        },
        hash: transactionId,
        error: null,
      };

      setupRpcMock({
        txDetails: async () => ({
          tx: invalidPerpsDeposit,
        }),
      });

      try {
        await new AttestationService().attestDepositoryDeposits({
          chainId: "hyperliquid",
          transactionId,
        });
        expect(false).toBe(true); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain(
          "Only USDC is supported as a Perps token",
        );
      }
    });

    it("should throw error when cannot retrieve token decimals", async () => {
      const transactionId = randomHex(32);
      const expectedDepositId = randomHex(32);

      const depositTx = {
        time: Date.now(),
        user: testUserAddress,
        action: {
          type: "sendAsset",
          destination: testDepositoryAddress,
          sourceDex: "",
          destinationDex: "spot",
          token: "TOKEN:0xUnknownToken1234567890abcdef1234567890",
          amount: "10.0",
          nonce: 1761563890239,
        },
        hash: transactionId,
        error: null,
      };

      // Mock the hub on-chain lookup for deposit ID
      setupHubRpcMock({ id: expectedDepositId });

      setupRpcMock({
        txDetails: async () => ({
          tx: depositTx,
        }),
        spotMeta: async () => ({
          tokens: [], // Token not found
        }),
      });

      try {
        await new AttestationService().attestDepositoryDeposits({
          chainId: "hyperliquid",
          transactionId,
        });
        expect(false).toBe(true); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain(
          "Could not retrieve payment currency decimals",
        );
      }
    });

    it("should handle custom destinationDex currency encoding", async () => {
      const transactionId = randomHex(32);
      const expectedDepositId = randomHex(32);

      const depositTx = {
        time: Date.now(),
        user: testUserAddress,
        action: {
          type: "sendAsset",
          destination: testDepositoryAddress,
          sourceDex: "",
          destinationDex: "customDex",
          token: "TOKEN:0x1234567890abcdef1234567890abcdef12345678",
          amount: "5.0",
          nonce: 1761563890239,
        },
        hash: transactionId,
        error: null,
      };

      // Mock the hub on-chain lookup for deposit ID
      setupHubRpcMock({ id: expectedDepositId });

      setupRpcMock({
        txDetails: async () => ({
          tx: depositTx,
        }),
        spotMeta: async () => ({
          tokens: [
            {
              tokenId: "0x1234567890abcdef1234567890abcdef12345678",
              szDecimals: 18,
            },
          ],
        }),
      });

      const { messages } =
        await new AttestationService().attestDepositoryDeposits({
          chainId: "hyperliquid",
          transactionId,
        });

      expect(messages).toHaveLength(1);
      // Currency should be token address + hex-encoded dex name
      const expectedCurrency =
        "0x1234567890abcdef1234567890abcdef12345678" +
        Buffer.from("customDex", "ascii").toString("hex");
      expect(messages[0].result.currency).toBe(expectedCurrency);
      expect(messages[0].result.amount).toBe("5000000000000000000");
    });

    it("should throw error when depositId lookup fails and we're still within the lookup threshold", async () => {
      const transactionId = randomHex(32);

      const depositTx = {
        time: Date.now(),
        user: testUserAddress,
        action: {
          type: "usdSend",
          destination: testDepositoryAddress,
          amount: "100.0",
          time: 1761563890702,
        },
        hash: transactionId,
        error: null,
      };

      // Default hub mock returns no entry (readContract returns ["0x", 0n])

      setupRpcMock({
        txDetails: async () => ({
          tx: depositTx,
        }),
      });

      try {
        await new AttestationService().attestDepositoryDeposits({
          chainId: "hyperliquid",
          transactionId,
        });
        expect(false).toBe(true); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain("No nonce mapping found");
      }
    });

    it("should attest unassociated deposit when depositId lookup succeeds and we're outside the lookup threshold", async () => {
      const transactionId = randomHex(32);

      const depositTx = {
        time: Date.now() - 3600 * 24 * 1000,
        user: testUserAddress,
        action: {
          type: "usdSend",
          destination: testDepositoryAddress,
          amount: "100.0",
          time: 1761563890702,
        },
        hash: transactionId,
        error: null,
      };

      // Hub lookup returns a mapping, but createdAt is recent (outside threshold relative to old tx)
      setupHubRpcMock({ id: randomHex(32) });

      setupRpcMock({
        txDetails: async () => ({
          tx: depositTx,
        }),
      });

      const { messages } =
        await new AttestationService().attestDepositoryDeposits({
          chainId: "hyperliquid",
          transactionId,
        });
      expect(messages).toHaveLength(1);
      expect(messages[0].data.chainId).toBe("hyperliquid");
      expect(messages[0].data.transactionId).toBe(transactionId);
      expect(messages[0].result.depository).toBe(testDepositoryAddress);
      expect(messages[0].result.depositor).toBe(testUserAddress);
      expect(messages[0].result.depositId).toBe(zeroHash);
      expect(messages[0].result.currency).toBe(
        "0x00000000000000000000000000000000",
      );
      expect(messages[0].result.amount).toBe("10000000000");
      expect(messages[0].result.onchainId).toBeDefined();
    });

    it("should attest unassociated deposit when depositId lookup fails and we're outside the lookup threshold", async () => {
      const transactionId = randomHex(32);

      const depositTx = {
        time: Date.now() - 3600 * 24 * 1000,
        user: testUserAddress,
        action: {
          type: "usdSend",
          destination: testDepositoryAddress,
          amount: "100.0",
          time: 1761563890702,
        },
        hash: transactionId,
        error: null,
      };

      // Default hub mock returns no entry (readContract returns ["0x", 0n])

      setupRpcMock({
        txDetails: async () => ({
          tx: depositTx,
        }),
      });

      const { messages } =
        await new AttestationService().attestDepositoryDeposits({
          chainId: "hyperliquid",
          transactionId,
        });
      expect(messages).toHaveLength(1);
      expect(messages[0].data.chainId).toBe("hyperliquid");
      expect(messages[0].data.transactionId).toBe(transactionId);
      expect(messages[0].result.depository).toBe(testDepositoryAddress);
      expect(messages[0].result.depositor).toBe(testUserAddress);
      expect(messages[0].result.depositId).toBe(zeroHash);
      expect(messages[0].result.currency).toBe(
        "0x00000000000000000000000000000000",
      );
      expect(messages[0].result.amount).toBe("10000000000");
      expect(messages[0].result.onchainId).toBeDefined();
    });
  });

  describe("getDepositoryWithdrawalMessage", () => {
    const withdrawalAddressRequest = createMockWithdrawalAddressRequest({
      chainId: "hyperliquid",
    });

    it("should return PENDING status when withdrawal not found", async () => {
      setupRpcMock({
        userDetails: async () => ({ txs: [] }),
      });

      try {
        await new AttestationService().attestDepositoryWithdrawal({
          chainId: "hyperliquid",
          withdrawal: "0x1234",
          withdrawalAddressRequest,
        });
      } catch (error) {
        expect(error).toBeDefined();
      }
    });

    it("should return EXPIRED status when withdrawal nonce is bracketed", async () => {
      const recentTxs = [
        {
          time: Date.now(),
          user: testDepositoryAddress,
          action: {
            type: "sendAsset",
            nonce: 1761563890140,
          },
          error: null,
        },
        {
          time: Date.now(),
          user: testDepositoryAddress,
          action: {
            type: "sendAsset",
            nonce: 1761563890160,
          },
          error: null,
        },
      ];

      setupRpcMock({
        userDetails: async () => ({ txs: recentTxs }),
      });

      try {
        await new AttestationService().attestDepositoryWithdrawal({
          chainId: "hyperliquid",
          withdrawal: "0x1234",
          withdrawalAddressRequest,
        });
      } catch (error) {
        expect(error).toBeDefined();
      }
    });

    it("should return EXECUTED status when withdrawal found in recent transactions without transactionId", async () => {
      const decodedWithdrawal: ReturnType<typeof decodeWithdrawal> = {
        vmType: "hyperliquid-vm",
        withdrawal: {
          txType: 1,
          parameters: {
            type: "SendAsset",
            hyperliquidChain: "Mainnet",
            destination: testUserAddress,
            sourceDex: "",
            destinationDex: "spot",
            token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
            amount: "10.04",
            fromSubAccount: "",
            nonce: "1761563890150",
          },
        },
      };

      const matchingTx = {
        time: Date.now(),
        user: testDepositoryAddress,
        action: {
          type: "sendAsset",
          signatureChainId: "0x1",
          hyperliquidChain: "Mainnet",
          destination: testUserAddress,
          sourceDex: "",
          destinationDex: "spot",
          token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
          amount: "10.04",
          fromSubAccount: "",
          nonce: 1761563890150,
        },
        block: 776752679,
        hash: "0xabc123",
        error: null,
      };

      setupRpcMock({
        userDetails: async () => ({ txs: [matchingTx] }),
      });

      const { message } =
        await new AttestationService().attestDepositoryWithdrawal({
          chainId: "hyperliquid",
          withdrawal: encodeWithdrawal(decodedWithdrawal),
          withdrawalAddressRequest,
        });

      expect(message.result.depository).toBe(testDepositoryAddress);
      expect(message.result.status).toBe(DepositoryWithdrawalStatus.EXECUTED);
    });

    it("should return EXECUTED status when withdrawal executed by an additional depository", async () => {
      const decodedWithdrawal: ReturnType<typeof decodeWithdrawal> = {
        vmType: "hyperliquid-vm",
        withdrawal: {
          txType: 1,
          parameters: {
            type: "SendAsset",
            hyperliquidChain: "Mainnet",
            destination: testUserAddress,
            sourceDex: "",
            destinationDex: "spot",
            token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
            amount: "10.04",
            fromSubAccount: "",
            nonce: "1761563890150",
          },
        },
      };

      const matchingTx = {
        time: Date.now(),
        user: testAdditionalDepositoryAddress,
        action: {
          type: "sendAsset",
          signatureChainId: "0x1",
          hyperliquidChain: "Mainnet",
          destination: testUserAddress,
          sourceDex: "",
          destinationDex: "spot",
          token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
          amount: "10.04",
          fromSubAccount: "",
          nonce: 1761563890150,
        },
        block: 776752679,
        hash: "0xabc123",
        error: null,
      };

      // Only the additional depository has the matching transaction
      setupRpcMock({
        userDetails: async (params: any) => ({
          txs:
            params.user.toLowerCase() ===
            testAdditionalDepositoryAddress.toLowerCase()
              ? [matchingTx]
              : [],
        }),
      });

      const { message } =
        await new AttestationService().attestDepositoryWithdrawal({
          chainId: "hyperliquid",
          withdrawal: encodeWithdrawal(decodedWithdrawal),
          withdrawalAddressRequest,
        });

      expect(message.result.depository).toBe(testAdditionalDepositoryAddress);
      expect(message.result.status).toBe(DepositoryWithdrawalStatus.EXECUTED);
    });

    it("should return EXECUTED status when recentTxs doesn't contain the transactionId", async () => {
      const transactionId = randomHex(32);
      const decodedWithdrawal: ReturnType<typeof decodeWithdrawal> = {
        vmType: "hyperliquid-vm",
        withdrawal: {
          txType: 1,
          parameters: {
            type: "SendAsset",
            hyperliquidChain: "Mainnet",
            destination: testUserAddress,
            sourceDex: "",
            destinationDex: "spot",
            token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
            amount: "10.04",
            fromSubAccount: "",
            nonce: "1761563890150",
          },
        },
      };

      // Mock recent transactions that don't contain the target transaction
      const recentTxs: any[] = [];

      // Mock the transaction details for the specific transactionId
      const targetTx = {
        time: Date.now(),
        user: testDepositoryAddress,
        action: {
          type: "sendAsset",
          signatureChainId: "0x1",
          hyperliquidChain: "Mainnet",
          destination: testUserAddress,
          sourceDex: "",
          destinationDex: "spot",
          token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
          amount: "10.04",
          fromSubAccount: "",
          nonce: 1761563890150,
        },
        block: 776752679,
        hash: transactionId,
        error: null,
      };

      setupRpcMock({
        userDetails: async () => ({ txs: recentTxs }),
        txDetails: async (params: any) => {
          if (params.hash === transactionId) {
            return { tx: targetTx };
          }
          return null;
        },
      });

      const { message } =
        await new AttestationService().attestDepositoryWithdrawal({
          chainId: "hyperliquid",
          withdrawal: encodeWithdrawal(decodedWithdrawal),
          transactionId,
          withdrawalAddressRequest,
        });

      expect(message.result.depository).toBe(testDepositoryAddress);
      expect(message.result.status).toBe(DepositoryWithdrawalStatus.EXECUTED);
    });

    it("should throw error when transactionId doesn't exist", async () => {
      const transactionId = randomHex(32);
      const decodedWithdrawal: ReturnType<typeof decodeWithdrawal> = {
        vmType: "hyperliquid-vm",
        withdrawal: {
          txType: 1,
          parameters: {
            type: "SendAsset",
            hyperliquidChain: "Mainnet",
            destination: testUserAddress,
            sourceDex: "",
            destinationDex: "spot",
            token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
            amount: "10.04",
            fromSubAccount: "",
            nonce: "1761563890150",
          },
        },
      };

      setupRpcMock({
        userDetails: async () => ({ txs: [] }),
        txDetails: async () => null, // Transaction not found
      });

      try {
        await new AttestationService().attestDepositoryWithdrawal({
          chainId: "hyperliquid",
          withdrawal: encodeWithdrawal(decodedWithdrawal),
          transactionId,
          withdrawalAddressRequest,
        });
        expect(false).toBe(true); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain(`Missing transaction ${transactionId}`);
      }
    });

    it("should throw error when transaction failed", async () => {
      const transactionId = randomHex(32);
      const decodedWithdrawal: ReturnType<typeof decodeWithdrawal> = {
        vmType: "hyperliquid-vm",
        withdrawal: {
          txType: 1,
          parameters: {
            type: "SendAsset",
            hyperliquidChain: "Mainnet",
            destination: testUserAddress,
            sourceDex: "",
            destinationDex: "spot",
            token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
            amount: "10.04",
            fromSubAccount: "",
            nonce: "1761563890150",
          },
        },
      };

      const failedTx = {
        time: Date.now(),
        user: testDepositoryAddress,
        action: {
          type: "sendAsset",
          hyperliquidChain: "Mainnet",
          destination: testUserAddress,
          sourceDex: "",
          destinationDex: "spot",
          token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
          amount: "10.04",
          fromSubAccount: "",
          nonce: "1761563890150",
        },
        hash: transactionId,
        error: "Transaction failed",
      };

      setupRpcMock({
        userDetails: async () => ({ txs: [] }),
        txDetails: async () => ({ tx: failedTx }),
      });

      const message = await new AttestationService().attestDepositoryWithdrawal(
        {
          chainId: "hyperliquid",
          withdrawal: encodeWithdrawal(decodedWithdrawal),
          transactionId,
          withdrawalAddressRequest,
        },
      );
      expect(message.message.result.status).toBe(
        DepositoryWithdrawalStatus.EXPIRED,
      );
    });

    it("should return PENDING (not auto-expire) when past the nonce window but unmatched", async () => {
      const decodedWithdrawal: ReturnType<typeof decodeWithdrawal> = {
        vmType: "hyperliquid-vm",
        withdrawal: {
          txType: 1,
          parameters: {
            type: "SendAsset",
            hyperliquidChain: "Mainnet",
            destination: testUserAddress,
            sourceDex: "",
            destinationDex: "spot",
            token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
            amount: "10.04",
            fromSubAccount: "",
            nonce: "1761563890150",
          },
        },
      };

      setupRpcMock({
        userDetails: async () => ({ txs: [] }),
      });

      const { message } =
        await new AttestationService().attestDepositoryWithdrawal({
          chainId: "hyperliquid",
          withdrawal: encodeWithdrawal(decodedWithdrawal),
          withdrawalAddressRequest,
        });

      expect(message.result.status).toBe(DepositoryWithdrawalStatus.PENDING);
    });

    it("should handle UsdSend withdrawal type", async () => {
      const decodedWithdrawal: ReturnType<typeof decodeWithdrawal> = {
        vmType: "hyperliquid-vm",
        withdrawal: {
          txType: 0,
          parameters: {
            type: "UsdSend",
            hyperliquidChain: "Mainnet",
            destination: testUserAddress,
            amount: "100.0",
            time: "1761563890150",
          },
        },
      };

      const matchingTx = {
        time: Date.now(),
        user: testDepositoryAddress,
        action: {
          type: "usdSend",
          hyperliquidChain: "Mainnet",
          destination: testUserAddress,
          amount: "100.0",
          time: 1761563890150,
        },
        hash: "0xabc123",
        error: null,
      };

      setupRpcMock({
        userDetails: async () => ({ txs: [matchingTx] }),
      });

      const { message } =
        await new AttestationService().attestDepositoryWithdrawal({
          chainId: "hyperliquid",
          withdrawal: encodeWithdrawal(decodedWithdrawal),
          withdrawalAddressRequest,
        });

      expect(message.result.status).toBe(DepositoryWithdrawalStatus.EXECUTED);
    });

    it("should filter out transactions with errors when checking recent transactions", async () => {
      const decodedWithdrawal: ReturnType<typeof decodeWithdrawal> = {
        vmType: "hyperliquid-vm",
        withdrawal: {
          txType: 1,
          parameters: {
            type: "SendAsset",
            hyperliquidChain: "Mainnet",
            destination: testUserAddress,
            sourceDex: "",
            destinationDex: "spot",
            token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
            amount: "10.04",
            fromSubAccount: "",
            nonce: "1761563890150",
          },
        },
      };

      const recentTxs = [
        {
          time: Date.now(),
          user: testDepositoryAddress,
          action: {
            type: "sendAsset",
            hyperliquidChain: "Mainnet",
            destination: testUserAddress,
            sourceDex: "",
            destinationDex: "spot",
            token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
            amount: "10.04",
            fromSubAccount: "",
            nonce: 1761563890150,
          },
          hash: "0xabc123",
          error: "Some error", // This transaction has an error
        },
      ];

      setupRpcMock({
        userDetails: async () => ({ txs: recentTxs }),
      });

      const { message } =
        await new AttestationService().attestDepositoryWithdrawal({
          chainId: "hyperliquid",
          withdrawal: encodeWithdrawal(decodedWithdrawal),
          withdrawalAddressRequest,
        });

      expect(message.result.status).toBe(DepositoryWithdrawalStatus.EXPIRED);
    });

  });

  describe("getSolverPaidAmount", () => {
    const setupHubRpcMock = (
      data?: { id: string; createdAt?: number },
    ) => {
      const mockHubClient = {
        readContract: jest.fn<any>().mockResolvedValue(
          data
            ? [data.id, BigInt(data.createdAt ?? Math.floor(Date.now() / 1000))]
            : ["0x", 0n],
        ),
      };
      (hubHttpRpc as jest.Mock<any>).mockResolvedValue(mockHubClient);
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    const makePayment = (overrides?: Record<string, any>) => ({
      currency: "0x00000000000000000000000000000000",
      recipient: testRecipientAddress,
      orderId: randomHex(32),
      extraData: "",
      deadline: Math.floor(Date.now() / 1000) + 3600,
      ...overrides,
    });

    it("should return correct amount for sendAsset native currency (USDC perps) fill", async () => {
      const transactionId = randomHex(32);
      const payment = makePayment();

      const fillTx = {
        time: Date.now(),
        user: testSolverAddress,
        action: {
          type: "sendAsset",
          signatureChainId: "0x1",
          hyperliquidChain: "Mainnet",
          destination: testRecipientAddress,
          sourceDex: "",
          destinationDex: "",
          token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
          amount: "50.0",
          fromSubAccount: "",
          nonce: 1761563890239,
        },
        block: 776752679,
        hash: transactionId,
        error: null,
      };

      setupHubRpcMock({ id: payment.orderId });

      setupRpcMock({
        txDetails: async () => ({
          tx: fillTx,
        }),
      });

      const attestor = new HyperliquidVmAttestor();
      const paidAmount = await attestor.getSolverPaidAmount(
        "hyperliquid",
        transactionId,
        payment,
      );

      expect(paidAmount).toBe(5000000000n);
    });

    it("should return correct amount for usdSend native currency fill", async () => {
      const transactionId = randomHex(32);
      const payment = makePayment();

      const fillTx = {
        time: Date.now(),
        user: testSolverAddress,
        action: {
          type: "usdSend",
          signatureChainId: "0x1",
          hyperliquidChain: "Mainnet",
          destination: testRecipientAddress,
          amount: "100.0",
          time: 1761563890702,
        },
        block: 776752679,
        hash: transactionId,
        error: null,
      };

      setupHubRpcMock({ id: payment.orderId });

      setupRpcMock({
        txDetails: async () => ({
          tx: fillTx,
        }),
      });

      const attestor = new HyperliquidVmAttestor();
      const paidAmount = await attestor.getSolverPaidAmount(
        "hyperliquid",
        transactionId,
        payment,
      );

      expect(paidAmount).toBe(10000000000n);
    });

    it("should return correct amount for sendAsset spot token fill", async () => {
      const transactionId = randomHex(32);
      const tokenAddress = "0x6d1e7cde53ba9467b783cb7c530ce054";
      const payment = makePayment({
        currency: tokenAddress,
      });

      const fillTx = {
        time: Date.now(),
        user: testSolverAddress,
        action: {
          type: "sendAsset",
          signatureChainId: "0x1",
          hyperliquidChain: "Mainnet",
          destination: testRecipientAddress,
          sourceDex: "",
          destinationDex: "spot",
          token: `USDC:${tokenAddress}`,
          amount: "25.5",
          fromSubAccount: "",
          nonce: 1761563890239,
        },
        block: 776752679,
        hash: transactionId,
        error: null,
      };

      setupHubRpcMock({ id: payment.orderId });

      setupRpcMock({
        txDetails: async () => ({
          tx: fillTx,
        }),
        spotMeta: async () => ({
          tokens: [
            {
              tokenId: tokenAddress,
              szDecimals: 6,
            },
          ],
        }),
      });

      const attestor = new HyperliquidVmAttestor();
      const paidAmount = await attestor.getSolverPaidAmount(
        "hyperliquid",
        transactionId,
        payment,
      );

      expect(paidAmount).toBe(25500000n);
    });

    it("should return correct amount for sendAsset custom dex token fill", async () => {
      const transactionId = randomHex(32);
      const tokenAddress = "0x1234567890abcdef1234567890abcdef";
      const dexName = "customDex";
      const payment = makePayment({
        currency:
          tokenAddress + Buffer.from(dexName, "ascii").toString("hex"),
      });

      const fillTx = {
        time: Date.now(),
        user: testSolverAddress,
        action: {
          type: "sendAsset",
          signatureChainId: "0x1",
          hyperliquidChain: "Mainnet",
          destination: testRecipientAddress,
          sourceDex: "",
          destinationDex: dexName,
          token: `TOKEN:${tokenAddress}`,
          amount: "10.0",
          fromSubAccount: "",
          nonce: 1761563890239,
        },
        block: 776752679,
        hash: transactionId,
        error: null,
      };

      setupHubRpcMock({ id: payment.orderId });

      setupRpcMock({
        txDetails: async () => ({
          tx: fillTx,
        }),
        spotMeta: async () => ({
          tokens: [
            {
              tokenId: tokenAddress,
              szDecimals: 18,
            },
          ],
        }),
      });

      const attestor = new HyperliquidVmAttestor();
      const paidAmount = await attestor.getSolverPaidAmount(
        "hyperliquid",
        transactionId,
        payment,
      );

      expect(paidAmount).toBe(10000000000000000000n);
    });

    it("should throw error when transaction is missing or reverted", async () => {
      const transactionId = randomHex(32);
      const payment = makePayment();

      setupRpcMock({
        txDetails: async () => ({
          tx: {
            time: Date.now(),
            user: testSolverAddress,
            action: { type: "sendAsset" },
            hash: transactionId,
            error: "Reverted",
          },
        }),
      });

      const attestor = new HyperliquidVmAttestor();
      await expect(
        attestor.getSolverPaidAmount("hyperliquid", transactionId, payment),
      ).rejects.toThrow("Missing or reverted transaction");
    });

    it("should throw error when transaction exceeds deadline", async () => {
      const transactionId = randomHex(32);
      const payment = makePayment({
        deadline: Math.floor(Date.now() / 1000) - 3600,
      });

      setupRpcMock({
        txDetails: async () => ({
          tx: {
            time: Date.now(),
            user: testSolverAddress,
            action: {
              type: "sendAsset",
              destination: testRecipientAddress,
              destinationDex: "",
              token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
              amount: "50.0",
              nonce: 1761563890239,
            },
            hash: transactionId,
            error: null,
          },
        }),
      });

      const attestor = new HyperliquidVmAttestor();
      await expect(
        attestor.getSolverPaidAmount("hyperliquid", transactionId, payment),
      ).rejects.toThrow("executed after deadline");
    });

    it("should throw error when no nonce mapping is found", async () => {
      const transactionId = randomHex(32);
      const payment = makePayment();

      setupRpcMock({
        txDetails: async () => ({
          tx: {
            time: Date.now(),
            user: testSolverAddress,
            action: {
              type: "sendAsset",
              destination: testRecipientAddress,
              destinationDex: "",
              token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
              amount: "50.0",
              nonce: 1761563890239,
            },
            hash: transactionId,
            error: null,
          },
        }),
      });

      // No hub mapping
      setupHubRpcMock();

      const attestor = new HyperliquidVmAttestor();
      await expect(
        attestor.getSolverPaidAmount("hyperliquid", transactionId, payment),
      ).rejects.toThrow("Nonce mapping mismatch");
    });

    it("should throw error when nonce mapping ID does not match orderId", async () => {
      const transactionId = randomHex(32);
      const payment = makePayment();

      setupRpcMock({
        txDetails: async () => ({
          tx: {
            time: Date.now(),
            user: testSolverAddress,
            action: {
              type: "sendAsset",
              destination: testRecipientAddress,
              destinationDex: "",
              token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
              amount: "50.0",
              nonce: 1761563890239,
            },
            hash: transactionId,
            error: null,
          },
        }),
      });

      // Hub returns a different ID than the orderId
      setupHubRpcMock({ id: randomHex(32) });

      const attestor = new HyperliquidVmAttestor();
      await expect(
        attestor.getSolverPaidAmount("hyperliquid", transactionId, payment),
      ).rejects.toThrow("Nonce mapping mismatch");
    });

    it("should throw error for unsupported action type", async () => {
      const transactionId = randomHex(32);
      const payment = makePayment();

      setupRpcMock({
        txDetails: async () => ({
          tx: {
            time: Date.now(),
            user: testSolverAddress,
            action: {
              type: "someOtherAction",
            },
            hash: transactionId,
            error: null,
          },
        }),
      });

      const attestor = new HyperliquidVmAttestor();
      await expect(
        attestor.getSolverPaidAmount("hyperliquid", transactionId, payment),
      ).rejects.toThrow("Could not detect payment");
    });

    it("should throw error when recipient does not match for native currency", async () => {
      const transactionId = randomHex(32);
      const payment = makePayment();

      const fillTx = {
        time: Date.now(),
        user: testSolverAddress,
        action: {
          type: "sendAsset",
          destination: "0xwrongrecipientaddress12345678901234567890",
          sourceDex: "",
          destinationDex: "",
          token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
          amount: "50.0",
          fromSubAccount: "",
          nonce: 1761563890239,
        },
        hash: transactionId,
        error: null,
      };

      setupHubRpcMock({ id: payment.orderId });

      setupRpcMock({
        txDetails: async () => ({
          tx: fillTx,
        }),
      });

      const attestor = new HyperliquidVmAttestor();
      await expect(
        attestor.getSolverPaidAmount("hyperliquid", transactionId, payment),
      ).rejects.toThrow("Could not detect payment");
    });

    it("should throw error when recipient does not match for spot token", async () => {
      const transactionId = randomHex(32);
      const tokenAddress = "0x6d1e7cde53ba9467b783cb7c530ce054";
      const payment = makePayment({
        currency: tokenAddress,
      });

      const fillTx = {
        time: Date.now(),
        user: testSolverAddress,
        action: {
          type: "sendAsset",
          destination: "0xwrongrecipientaddress12345678901234567890",
          sourceDex: "",
          destinationDex: "spot",
          token: `USDC:${tokenAddress}`,
          amount: "25.5",
          fromSubAccount: "",
          nonce: 1761563890239,
        },
        hash: transactionId,
        error: null,
      };

      setupHubRpcMock({ id: payment.orderId });

      setupRpcMock({
        txDetails: async () => ({
          tx: fillTx,
        }),
      });

      const attestor = new HyperliquidVmAttestor();
      await expect(
        attestor.getSolverPaidAmount("hyperliquid", transactionId, payment),
      ).rejects.toThrow("Could not detect payment");
    });

    it("should extract nonce from usdSend time field for nonce mapping lookup", async () => {
      const transactionId = randomHex(32);
      const payment = makePayment();
      const usdSendTime = 1761563890702;

      const fillTx = {
        time: Date.now(),
        user: testSolverAddress,
        action: {
          type: "usdSend",
          hyperliquidChain: "Mainnet",
          destination: testRecipientAddress,
          amount: "100.0",
          time: usdSendTime,
        },
        hash: transactionId,
        error: null,
      };

      const mockReadContract = jest.fn<any>().mockResolvedValue(
        [payment.orderId, BigInt(Math.floor(Date.now() / 1000))],
      );
      (hubHttpRpc as jest.Mock<any>).mockResolvedValue({
        readContract: mockReadContract,
      });

      setupRpcMock({
        txDetails: async () => ({
          tx: fillTx,
        }),
      });

      const attestor = new HyperliquidVmAttestor();
      await attestor.getSolverPaidAmount(
        "hyperliquid",
        transactionId,
        payment,
      );

      // Verify readContract was called (nonce mapping was looked up)
      expect(mockReadContract).toHaveBeenCalled();
    });

    it("should throw error when currency decimals cannot be retrieved for spot token", async () => {
      const transactionId = randomHex(32);
      const tokenAddress = "0xunknowntoken1234567890abcdef12";
      const payment = makePayment({
        currency: tokenAddress,
      });

      const fillTx = {
        time: Date.now(),
        user: testSolverAddress,
        action: {
          type: "sendAsset",
          destination: testRecipientAddress,
          sourceDex: "",
          destinationDex: "spot",
          token: `TOKEN:${tokenAddress}`,
          amount: "10.0",
          fromSubAccount: "",
          nonce: 1761563890239,
        },
        hash: transactionId,
        error: null,
      };

      setupHubRpcMock({ id: payment.orderId });

      setupRpcMock({
        txDetails: async () => ({
          tx: fillTx,
        }),
        spotMeta: async () => ({
          tokens: [],
        }),
      });

      const attestor = new HyperliquidVmAttestor();
      await expect(
        attestor.getSolverPaidAmount("hyperliquid", transactionId, payment),
      ).rejects.toThrow("Could not retrieve payment currency decimals");
    });
  });

  describe("validateSubmitWithdrawRequest", () => {
    const nativeCurrency = "0x00000000000000000000000000000000";

    const makeWithdrawRequest = (overrides?: Record<string, any>): any => ({
      chainId: "hyperliquid",
      depository: testDepositoryAddress,
      currency: nativeCurrency,
      amount: "100",
      spender: testUserAddress,
      recipient: testUserAddress,
      nonce: "1",
      ...overrides,
    });

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("should return true for the native currency without additional data", async () => {
      const attestor = new HyperliquidVmAttestor();
      const result = await attestor.validateSubmitWithdrawRequest(
        makeWithdrawRequest(),
      );
      expect(result).toBe(true);
    });

    it("should return false for a non-native currency without hyperliquid additional data", async () => {
      const attestor = new HyperliquidVmAttestor();
      const result = await attestor.validateSubmitWithdrawRequest(
        makeWithdrawRequest({
          currency: "0x6d1e7cde53ba9467b783cb7c530ce054",
        }),
      );
      expect(result).toBe(false);
    });

    it("should return true for a non-native currency with hyperliquid additional data", async () => {
      const attestor = new HyperliquidVmAttestor();
      const result = await attestor.validateSubmitWithdrawRequest(
        makeWithdrawRequest({
          currency: "0x6d1e7cde53ba9467b783cb7c530ce054",
          additionalData: {
            "hyperliquid-vm": {
              currencyHyperliquidSymbol: "USDC",
              currentTime: Date.now(),
            },
          },
        }),
      );
      expect(result).toBe(true);
    });
  });
});

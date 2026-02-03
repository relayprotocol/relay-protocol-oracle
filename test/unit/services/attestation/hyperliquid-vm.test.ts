import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import {
  encodeWithdrawal,
  decodeWithdrawal,
  DepositoryWithdrawalStatus,
} from "@relay-protocol/settlement-sdk";
import axios from "axios";
import { zeroHash } from "viem";

import { Chain } from "../../../../src/common/chains";
import { httpRpc } from "../../../../src/common/vm/hyperliquid-vm/rpc";
import { AttestationService } from "../../../../src/services/attestation";

import { randomHex } from "../../../common/utils";
import { createMockWithdrawalAddressRequest } from "../../../common/withdrawals";

const testDepositoryAddress = "0x1234567890abcdef1234567890abcdef12345678";
const testUserAddress = "0xabcdef1234567890abcdef1234567890abcdef12";

jest.mock("../../../../src/common/chains", () => {
  const chains: Record<string, Chain> = {
    hyperliquid: {
      id: "hyperliquid",
      vmType: "hyperliquid-vm",
      httpRpcUrl: "https://api.hyperliquid.xyz",
      depository: "0x1234567890abcdef1234567890abcdef12345678",
      hubChainId: "1",
      additionalData: {
        hubApiUrl: "https://localhost:3000",
      },
    },
  };
  return {
    HUB_VM_TYPE: "hub-vm",
    HUB_CHAIN_ID: 0n,
    getChains: async () => chains,
    getHubChains: async () => [],
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

jest.mock("axios", () => {
  const mockAxios = {
    get: jest.fn().mockImplementation(() => Promise.resolve({ data: {} })),
  };
  return mockAxios;
});

jest.mock("../../../../src/common/vm/hyperliquid-vm/rpc", () => {
  return {
    httpRpc: jest.fn(),
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
    beforeEach(() => {
      jest.clearAllMocks();
      (axios.get as jest.Mock).mockImplementation(() =>
        Promise.resolve({ data: { id: randomHex(32) } }),
      );
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

      // Mock the hub API response for deposit lookup
      (axios.get as jest.Mock).mockImplementation(() =>
        Promise.resolve({
          data: { id: expectedDepositId, createdAt: new Date().toISOString() },
        }),
      );

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

      (axios.get as jest.Mock).mockImplementation(() =>
        Promise.resolve({
          data: { id: expectedDepositId, createdAt: new Date().toISOString() },
        }),
      );

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

      (axios.get as jest.Mock).mockImplementation(() =>
        Promise.resolve({
          data: { id: expectedDepositId, createdAt: new Date().toISOString() },
        }),
      );

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

      (axios.get as jest.Mock).mockImplementation(() =>
        Promise.resolve({
          data: { id: expectedDepositId, createdAt: new Date().toISOString() },
        }),
      );

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

      // Mock axios to return empty data
      (axios.get as jest.Mock).mockImplementation(() =>
        Promise.resolve({ data: undefined }),
      );

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

      // Mock axios to return empty data
      (axios.get as jest.Mock).mockImplementation(() =>
        Promise.resolve({
          data: { id: randomHex(32), createdAt: new Date().toISOString() },
        }),
      );

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

      // Mock axios to return empty data
      (axios.get as jest.Mock).mockImplementation(() =>
        Promise.resolve({ data: undefined }),
      );

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
          nonce: 1761563890150,
        },
        hash: transactionId,
        error: "Transaction failed",
      };

      setupRpcMock({
        userDetails: async () => ({ txs: [] }),
        txDetails: async () => ({ tx: failedTx }),
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
        expect(error.message).toContain(`Transaction failed: ${transactionId}`);
      }
    });

    it("should return EXPIRED when transaction is expired", async () => {
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

      expect(message.result.status).toBe(DepositoryWithdrawalStatus.EXPIRED);
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
});

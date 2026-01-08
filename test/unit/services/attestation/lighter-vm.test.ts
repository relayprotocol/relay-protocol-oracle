import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import {
  TransactionStatus,
  TransactionType,
} from "@reservoir0x/lighter-ts-sdk";

import { Chain } from "../../../../src/common/chains";
import { httpRpc } from "../../../../src/common/vm/lighter-vm/rpc";
import { LighterVmAttestor } from "../../../../src/services/attestation/vm/lighter-vm";

import { randomHex } from "../../../common/utils";

const testDepositoryAddress = "460491";
const testRecipientAddress = "462196";

jest.mock("../../../../src/common/chains", () => {
  const chains: Record<string, Chain> = {
    lighter: {
      id: "lighter",
      vmType: "lighter-vm",
      httpRpcUrl: "https://api.lighter.xyz",
      hubChainId: "1",
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
        Object.values(chains).map((chain) => [chain.id, chain.vmType])
      ),
  };
});

jest.mock("../../../../src/common/vm/lighter-vm/rpc", () => {
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

describe("LighterVmAttestor", () => {
  describe("getSolverPaidAmount", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("should correctly verify USDC payment amount for EXECUTED and COMMITTED transactions", async () => {
      const transactionId = randomHex(32);
      const paymentAmount = 1000000; // 1 USDC (6 decimals)

      const mockTransaction = {
        code: 200,
        hash: transactionId,
        type: TransactionType.TRANSFER,
        info: JSON.stringify({
          FromAccountIndex: Number(testDepositoryAddress),
          ApiKeyIndex: 3,
          ToAccountIndex: Number(testRecipientAddress),
          AssetIndex: 3,
          FromRouteType: 0,
          ToRouteType: 0,
          Amount: paymentAmount,
          USDCFee: 3000000,
          Memo: [116, 114, 97, 110, 115, 102, 101, 114, 45, 105, 100],
          ExpiredAt: 1763299591909,
          Nonce: 1,
          Sig: "signature",
          L1Sig: "0x1234...",
        }),
        status: TransactionStatus.EXECUTED,
        transaction_index: 443,
        l1_address: "0x8B5E4dB198FfC7f69f8F11F6592f682717dF1D92",
        account_index: Number(testDepositoryAddress),
        nonce: 1,
        expire_at: 1763299591909,
        block_height: 97526892,
        queued_at: 1763298993375,
        sequence_index: 27657305907,
        committed_at: 0,
        verified_at: 0,
        executed_at: 1763298993242,
      };

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() => Promise.resolve(mockTransaction)),
        },
      });

      const payment = {
        currency: "0", // LVM native currency (USDC)
        recipient: testRecipientAddress,
        orderId: "test-order-id",
        extraData: "",
        deadline: Math.floor(mockTransaction.queued_at / 1000) + 3600, // 1 hour after transaction
      };

      const attestor = new LighterVmAttestor();
      const paidAmount = await attestor.getSolverPaidAmount(
        "lighter",
        transactionId,
        payment
      );

      expect(paidAmount).toBe(BigInt(paymentAmount));

      // Also test COMMITTED status
      mockTransaction.status = TransactionStatus.COMMITTED;
      const paidAmount2 = await attestor.getSolverPaidAmount(
        "lighter",
        transactionId,
        payment
      );
      expect(paidAmount2).toBe(BigInt(paymentAmount));
    });

    it("should throw error when transaction is not found", async () => {
      const transactionId = randomHex(32);

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() => Promise.resolve(null)),
        },
      });

      const payment = {
        currency: "0",
        recipient: testRecipientAddress,
        orderId: "test-order-id",
        extraData: "",
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };

      const attestor = new LighterVmAttestor();

      try {
        await attestor.getSolverPaidAmount("lighter", transactionId, payment);
        expect(false).toBe(true); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain(`Missing transaction ${transactionId}`);
      }
    });

    it("should throw error when transaction is not committed or executed", async () => {
      const transactionId = randomHex(32);

      const mockTransaction = {
        hash: transactionId,
        type: TransactionType.TRANSFER,
        status: TransactionStatus.QUEUED, // Not committed or executed
        queued_at: 1763298993375,
        info: "{}",
      };

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() => Promise.resolve(mockTransaction)),
        },
      });

      const payment = {
        currency: "0",
        recipient: testRecipientAddress,
        orderId: "test-order-id",
        extraData: "",
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };

      const attestor = new LighterVmAttestor();

      try {
        await attestor.getSolverPaidAmount("lighter", transactionId, payment);
        expect(false).toBe(true); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain("Missing or reverted transaction");
      }
    });

    it("should throw error when transaction exceeds deadline", async () => {
      const transactionId = randomHex(32);
      const queuedAt = 1763298993375;

      const mockTransaction = {
        hash: transactionId,
        type: TransactionType.TRANSFER,
        status: TransactionStatus.EXECUTED,
        queued_at: queuedAt,
        info: JSON.stringify({
          FromAccountIndex: Number(testDepositoryAddress),
          ToAccountIndex: Number(testRecipientAddress),
          AssetIndex: 3,
          FromRouteType: 0,
          ToRouteType: 0,
          Amount: 1000,
        }),
      };

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() => Promise.resolve(mockTransaction)),
        },
      });

      const payment = {
        currency: "0",
        recipient: testRecipientAddress,
        orderId: "test-order-id",
        extraData: "",
        deadline: Math.floor(queuedAt / 1000) - 3600, // 1 hour before transaction
      };

      const attestor = new LighterVmAttestor();

      try {
        await attestor.getSolverPaidAmount("lighter", transactionId, payment);
        expect(false).toBe(true); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain("executed after deadline");
      }
    });

    it("should throw error when payment cannot be detected", async () => {
      const transactionId = randomHex(32);
      const attestor = new LighterVmAttestor();

      // Test case 1: Wrong recipient
      const mockTransaction1 = {
        hash: transactionId,
        type: TransactionType.TRANSFER,
        status: TransactionStatus.EXECUTED,
        queued_at: 1763298993375,
        info: JSON.stringify({
          FromAccountIndex: Number(testDepositoryAddress),
          ToAccountIndex: Number(testRecipientAddress),
          AssetIndex: 3,
          FromRouteType: 0,
          ToRouteType: 0,
          Amount: 1000000,
          USDCFee: 3000000,
        }),
      };

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() => Promise.resolve(mockTransaction1)),
        },
      });

      try {
        await attestor.getSolverPaidAmount("lighter", transactionId, {
          currency: "0",
          recipient: "999999", // Wrong recipient
          orderId: "test-order-id",
          extraData: "",
          deadline: Math.floor(Date.now() / 1000) + 3600,
        });
        expect(false).toBe(true);
      } catch (error: any) {
        expect(error.message).toContain("Could not detect payment");
      }

      // Test case 2: Wrong transaction type
      const mockTransaction2 = {
        ...mockTransaction1,
        type: TransactionType.WITHDRAW,
      };

      setupRpcMock({
        transactionApi: {
          getTransaction: jest.fn(() => Promise.resolve(mockTransaction2)),
        },
      });

      try {
        await attestor.getSolverPaidAmount("lighter", transactionId, {
          currency: "0",
          recipient: testRecipientAddress,
          orderId: "test-order-id",
          extraData: "",
          deadline: Math.floor(Date.now() / 1000) + 3600,
        });
        expect(false).toBe(true);
      } catch (error: any) {
        expect(error.message).toContain("Could not detect payment");
      }
    });
  });
});

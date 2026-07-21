// ABOUTME: Unit tests for XrpVmAttestor — fill (getSolverPaidAmount) and deposit
// ABOUTME: (getDepositoryDepositMessages) paths. Fixtures shaped per real XRPL RPC.
import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import {
  DecodedXrpVmWithdrawal,
  DepositoryWithdrawalStatus,
  encodeWithdrawal,
  getVmTypeNativeCurrency,
} from "@relay-protocol/settlement-sdk";
import { zeroHash } from "viem";

import { Chain } from "../../../../src/common/chains";
import { logger } from "../../../../src/common/logger";
import {
  httpRpc,
  XrpAccountInfo,
  XrpTransaction,
} from "../../../../src/common/vm/xrp-vm/rpc";
import { XrpVmAttestor } from "../../../../src/services/attestation/vm/xrp-vm";

// Real, valid classic addresses (from mainnet txs) so the SDK codec accepts them.
const DEPOSITORY = "rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv";
const RECIPIENT = "rXzRVoohqvahY4zyUrfmznpVgkLJsDCtd";
const SOLVER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const DEPOSITOR = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const OTHER = "rBEARGUAsyu7tUw53rufQzFdWmJHpJEqFW";

const TX_HASH =
  "32592FD060D858EC5C6FA47B8AE8A4DE59F34B1AC864AF052A40F83D25BE7B34";
const ORDER_ID = "0x" + "ab".repeat(32);

const NATIVE = getVmTypeNativeCurrency("xrp-vm");

// Ripple epoch → Unix: Unix = date + 946684800.
const RIPPLE_EPOCH_OFFSET = 946684800;
const TX_DATE = 800000000;
const TX_UNIX = TX_DATE + RIPPLE_EPOCH_OFFSET;

// Solver encodes MemoData = hex(UTF-8(memo)).toUpperCase() (single MemoData-only memo).
const hexMemo = (text: string) => [
  { Memo: { MemoData: Buffer.from(text, "utf8").toString("hex").toUpperCase() } },
];

const iouAmount = { currency: "USD", issuer: OTHER, value: "1.0" };

jest.mock("../../../../src/common/chains", () => {
  const chains: Record<string, Chain> = {
    xrp: {
      id: "xrp",
      vmType: "xrp-vm",
      httpRpcUrl: "https://example.invalid/",
      depository: "rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv",
      hubChainId: "1",
    },
    // Invalid config for the rejection test: depository as an X-address (must be classic).
    "xrp-xaddr": {
      id: "xrp-xaddr",
      vmType: "xrp-vm",
      httpRpcUrl: "https://example.invalid/",
      depository: "XV3oNHx95sqdCkTDCBCVsVeuBmvh2du1vBfJR24EqdgwHDW",
      hubChainId: "1",
    },
  };
  return {
    getChains: async () => chains,
    getChain: async (chainId: string) => chains[chainId],
    getChainVmType: async (chainId: string) => chains[chainId].vmType,
    getChainHubChainId: async (chainId: string) => chains[chainId].hubChainId,
    getSdkChainsConfig: () =>
      Object.fromEntries(
        Object.values(chains).map((chain) => [chain.id, chain.vmType]),
      ),
  };
});

jest.mock("../../../../src/common/vm/xrp-vm/rpc", () => ({
  httpRpc: jest.fn(),
}));

const fillTx = (overrides: Partial<XrpTransaction> = {}): XrpTransaction => ({
  hash: TX_HASH,
  TransactionType: "Payment",
  Account: SOLVER,
  Destination: RECIPIENT,
  Amount: "1000000",
  date: TX_DATE,
  validated: true,
  Memos: hexMemo(ORDER_ID),
  meta: { TransactionResult: "tesSUCCESS", delivered_amount: "1000000" },
  ...overrides,
});

const depositTx = (overrides: Partial<XrpTransaction> = {}): XrpTransaction => ({
  hash: TX_HASH,
  TransactionType: "Payment",
  Account: DEPOSITOR,
  Destination: DEPOSITORY,
  Amount: "5000000",
  date: TX_DATE,
  validated: true,
  Memos: hexMemo(ORDER_ID),
  meta: { TransactionResult: "tesSUCCESS", delivered_amount: "5000000" },
  ...overrides,
});

const payment = (overrides: Record<string, unknown> = {}) => ({
  currency: NATIVE,
  recipient: RECIPIENT,
  orderId: ORDER_ID,
  extraData: "0x",
  deadline: TX_UNIX + 3600,
  ...overrides,
});

// ===== Withdrawal (getDepositoryWithdrawalMessage) fixtures =====
// The withdrawal payload pins Sequence = N and LastLedgerSequence = LLS on the
// depository. The oracle reads the depository's current sequence (S) and the
// validated ledger (L) to decide PENDING / EXECUTED / EXPIRED.
const WITHDRAWAL_N = 100;
const WITHDRAWAL_LLS = 5000;
const WITHDRAWAL_AMOUNT = "2000000";
const WITHDRAWAL_TX_HASH = "A".repeat(64);
const OTHER_TX_HASH = "B".repeat(64);
// tfFullyCanonicalSig; 33-byte compressed secp256k1 pubkey the allocator signs with.
const WITHDRAWAL_FLAGS = 0x80000000;
const SIGNING_PUBKEY = "0x02" + "ab".repeat(32);

const decodedWithdrawal = (
  overrides: Partial<DecodedXrpVmWithdrawal["withdrawal"]> = {},
): DecodedXrpVmWithdrawal => ({
  vmType: "xrp-vm",
  withdrawal: {
    account: DEPOSITORY,
    destination: RECIPIENT,
    amount: WITHDRAWAL_AMOUNT,
    fee: "12",
    sequence: WITHDRAWAL_N,
    lastLedgerSequence: WITHDRAWAL_LLS,
    flags: WITHDRAWAL_FLAGS,
    signingPubKey: SIGNING_PUBKEY,
    ...overrides,
  },
});

const encodedWithdrawal = (
  overrides: Partial<DecodedXrpVmWithdrawal["withdrawal"]> = {},
): string => encodeWithdrawal(decodedWithdrawal(overrides));

// The depository's own outbound withdrawal Payment (consumes Sequence N). Fee /
// Flags / SigningPubKey mirror the payload so the on-chain rebuild reconstructs to
// the same signing-hash withdrawalId (the EXECUTED identity check).
const withdrawalTx = (
  overrides: Partial<XrpTransaction> = {},
): XrpTransaction => ({
  hash: WITHDRAWAL_TX_HASH,
  TransactionType: "Payment",
  Account: DEPOSITORY,
  Destination: RECIPIENT,
  Amount: WITHDRAWAL_AMOUNT,
  Fee: "12",
  Sequence: WITHDRAWAL_N,
  LastLedgerSequence: WITHDRAWAL_LLS,
  Flags: WITHDRAWAL_FLAGS,
  SigningPubKey: SIGNING_PUBKEY,
  date: TX_DATE,
  validated: true,
  ledger_index: WITHDRAWAL_LLS - 5,
  meta: { TransactionResult: "tesSUCCESS", delivered_amount: WITHDRAWAL_AMOUNT },
  ...overrides,
});

const accountInfo = (
  sequence: number,
  ledgerIndex: number,
  overrides: Partial<XrpAccountInfo> = {},
): XrpAccountInfo => ({
  account_data: { Sequence: sequence },
  ledger_index: ledgerIndex,
  validated: true,
  ...overrides,
});

describe("XrpVmAttestor", () => {
  const attestor = new XrpVmAttestor();
  const getTransaction =
    jest.fn<(id: string) => Promise<XrpTransaction | null>>();
  const getAccountInfo =
    jest.fn<(account: string) => Promise<XrpAccountInfo | null>>();
  const warnSpy = jest
    .spyOn(logger, "warn")
    .mockImplementation((() => undefined) as never);

  beforeEach(() => {
    getTransaction.mockReset();
    getAccountInfo.mockReset();
    warnSpy.mockClear();
    jest.mocked(httpRpc).mockResolvedValue({
      getTransaction,
      getAccountInfo,
    } as unknown as Awaited<ReturnType<typeof httpRpc>>);
  });

  describe("getSolverPaidAmount", () => {
    it("returns the delivered amount for a valid native fill", async () => {
      getTransaction.mockResolvedValue(fillTx());
      const amount = await attestor.getSolverPaidAmount(
        "xrp",
        TX_HASH,
        payment(),
      );
      expect(amount).toBe(1000000n);
    });

    it("matches an X-address recipient against the classic destination", async () => {
      // Tagless X-address form of RECIPIENT (same underlying account) — a plain
      // string compare would false-reject this valid fill.
      const xAddressRecipient = "X7VHoQiCPRS5qM2G8fa9XPACCFgsoxmuswNxLuMaDs7cBRr";
      getTransaction.mockResolvedValue(fillTx());
      const amount = await attestor.getSolverPaidAmount(
        "xrp",
        TX_HASH,
        payment({ recipient: xAddressRecipient }),
      );
      expect(amount).toBe(1000000n);
    });

    it("returns delivered_amount (not Amount) for a partial payment", async () => {
      getTransaction.mockResolvedValue(
        fillTx({
          Amount: "120380",
          meta: { TransactionResult: "tesSUCCESS", delivered_amount: "80253" },
        }),
      );
      const amount = await attestor.getSolverPaidAmount(
        "xrp",
        TX_HASH,
        payment(),
      );
      expect(amount).toBe(80253n);
    });

    it("accepts a tx delivered exactly at the deadline (epoch-converted)", async () => {
      getTransaction.mockResolvedValue(fillTx());
      const amount = await attestor.getSolverPaidAmount(
        "xrp",
        TX_HASH,
        payment({ deadline: TX_UNIX }),
      );
      expect(amount).toBe(1000000n);
    });

    it("rejects a malformed transaction id", async () => {
      await expect(
        attestor.getSolverPaidAmount("xrp", "not-a-hash", payment()),
      ).rejects.toThrow("expected 64 hex chars");
    });

    it("rejects a missing transaction", async () => {
      getTransaction.mockResolvedValue(null);
      await expect(
        attestor.getSolverPaidAmount("xrp", TX_HASH, payment()),
      ).rejects.toThrow("Missing transaction");
    });

    it("rejects an unvalidated transaction", async () => {
      getTransaction.mockResolvedValue(fillTx({ validated: false }));
      await expect(
        attestor.getSolverPaidAmount("xrp", TX_HASH, payment()),
      ).rejects.toThrow("not yet validated");
    });

    it("rejects a tec (included but not executed) transaction", async () => {
      getTransaction.mockResolvedValue(
        fillTx({ meta: { TransactionResult: "tecUNFUNDED_PAYMENT" } }),
      );
      await expect(
        attestor.getSolverPaidAmount("xrp", TX_HASH, payment()),
      ).rejects.toThrow("did not succeed");
    });

    it("rejects a non-Payment transaction", async () => {
      getTransaction.mockResolvedValue(fillTx({ TransactionType: "OfferCreate" }));
      await expect(
        attestor.getSolverPaidAmount("xrp", TX_HASH, payment()),
      ).rejects.toThrow("is not a Payment");
    });

    it("rejects payment to the wrong recipient", async () => {
      getTransaction.mockResolvedValue(fillTx({ Destination: OTHER }));
      await expect(
        attestor.getSolverPaidAmount("xrp", TX_HASH, payment()),
      ).rejects.toThrow("was not paid to");
    });

    it("rejects a non-native (issued) currency order", async () => {
      getTransaction.mockResolvedValue(fillTx());
      await expect(
        attestor.getSolverPaidAmount("xrp", TX_HASH, payment({ currency: OTHER })),
      ).rejects.toThrow("Unsupported currency");
    });

    it("rejects an issued-currency (IOU) delivery", async () => {
      getTransaction.mockResolvedValue(
        fillTx({
          meta: { TransactionResult: "tesSUCCESS", delivered_amount: iouAmount },
        }),
      );
      await expect(
        attestor.getSolverPaidAmount("xrp", TX_HASH, payment()),
      ).rejects.toThrow("did not deliver native XRP");
    });

    it("rejects a tx that does not reference the order id", async () => {
      getTransaction.mockResolvedValue(
        fillTx({ Memos: hexMemo("0x" + "cd".repeat(32)) }),
      );
      await expect(
        attestor.getSolverPaidAmount("xrp", TX_HASH, payment()),
      ).rejects.toThrow("does not reference order id");
    });

    it("rejects a tx that references multiple order ids (double-claim guard)", async () => {
      const otherOrderId = "0x" + "cd".repeat(32);
      getTransaction.mockResolvedValue(
        fillTx({
          Memos: [...hexMemo(ORDER_ID), ...hexMemo(otherOrderId)],
        }),
      );
      await expect(
        attestor.getSolverPaidAmount("xrp", TX_HASH, payment()),
      ).rejects.toThrow("references multiple order ids");
    });

    it("rejects a tx with no memos", async () => {
      getTransaction.mockResolvedValue(fillTx({ Memos: undefined }));
      await expect(
        attestor.getSolverPaidAmount("xrp", TX_HASH, payment()),
      ).rejects.toThrow("does not reference order id");
    });

    it("rejects a tx executed after the deadline", async () => {
      getTransaction.mockResolvedValue(fillTx());
      await expect(
        attestor.getSolverPaidAmount("xrp", TX_HASH, payment({ deadline: TX_UNIX - 1 })),
      ).rejects.toThrow("after deadline");
    });
  });

  describe("getDepositoryDepositMessages", () => {
    it("attests a valid native deposit with an order id memo", async () => {
      getTransaction.mockResolvedValue(depositTx());
      const messages = await attestor.getDepositoryDepositMessages("xrp", TX_HASH);
      expect(messages).toHaveLength(1);
      expect(messages[0].result).toMatchObject({
        depository: DEPOSITORY,
        depositId: ORDER_ID,
        depositor: DEPOSITOR,
        currency: NATIVE,
        amount: "5000000",
      });
      expect(messages[0].extraData.timestamp).toBe(String(TX_UNIX));
      expect(messages[0].result.onchainId).toBeDefined();
    });

    it("falls back to the zero hash when there is no memo", async () => {
      getTransaction.mockResolvedValue(depositTx({ Memos: undefined }));
      const messages = await attestor.getDepositoryDepositMessages("xrp", TX_HASH);
      expect(messages[0].result.depositId).toBe(zeroHash);
    });

    it("falls back to the zero hash for a non-canonical memo", async () => {
      getTransaction.mockResolvedValue(depositTx({ Memos: hexMemo("hello world") }));
      const messages = await attestor.getDepositoryDepositMessages("xrp", TX_HASH);
      expect(messages[0].result.depositId).toBe(zeroHash);
    });

    it("skips an outbound sweep from the depository", async () => {
      getTransaction.mockResolvedValue(depositTx({ Account: DEPOSITORY }));
      const messages = await attestor.getDepositoryDepositMessages("xrp", TX_HASH);
      expect(messages).toEqual([]);
    });

    it("skips a payment not addressed to the depository", async () => {
      getTransaction.mockResolvedValue(depositTx({ Destination: OTHER }));
      const messages = await attestor.getDepositoryDepositMessages("xrp", TX_HASH);
      expect(messages).toEqual([]);
    });

    it("skips an issued-currency (IOU) delivery to the depository", async () => {
      getTransaction.mockResolvedValue(
        depositTx({
          meta: { TransactionResult: "tesSUCCESS", delivered_amount: iouAmount },
        }),
      );
      const messages = await attestor.getDepositoryDepositMessages("xrp", TX_HASH);
      expect(messages).toEqual([]);
    });

    it("skips a non-Payment transaction", async () => {
      getTransaction.mockResolvedValue(depositTx({ TransactionType: "OfferCreate" }));
      const messages = await attestor.getDepositoryDepositMessages("xrp", TX_HASH);
      expect(messages).toEqual([]);
    });

    it("rejects an unvalidated deposit", async () => {
      getTransaction.mockResolvedValue(depositTx({ validated: false }));
      await expect(
        attestor.getDepositoryDepositMessages("xrp", TX_HASH),
      ).rejects.toThrow("not yet validated");
    });

    it("rejects a tec deposit", async () => {
      getTransaction.mockResolvedValue(
        depositTx({ meta: { TransactionResult: "tecUNFUNDED_PAYMENT" } }),
      );
      await expect(
        attestor.getDepositoryDepositMessages("xrp", TX_HASH),
      ).rejects.toThrow("did not succeed");
    });

    it("rejects a missing deposit transaction", async () => {
      getTransaction.mockResolvedValue(null);
      await expect(
        attestor.getDepositoryDepositMessages("xrp", TX_HASH),
      ).rejects.toThrow("Missing transaction");
    });

    it("rejects a chain whose depository is configured as an X-address", async () => {
      // Depository must be classic r... — it is passed to account_info/account_tx
      // which reject X-addresses. Fail loud on config, not at RPC.
      await expect(
        attestor.getDepositoryDepositMessages("xrp-xaddr", TX_HASH),
      ).rejects.toThrow("must be a classic r... address");
    });
  });

  describe("getDepositoryWithdrawalMessage", () => {
    it("reports PENDING while the sequence is unconsumed and within the ledger window", async () => {
      // S = N (not yet consumed), L = LLS - 10 (still landable).
      getAccountInfo.mockResolvedValue(accountInfo(WITHDRAWAL_N, WITHDRAWAL_LLS - 10));
      const message = await attestor.getDepositoryWithdrawalMessage(
        "xrp",
        encodedWithdrawal(),
      );
      expect(message.result.status).toBe(DepositoryWithdrawalStatus.PENDING);
      expect(message.result.depository).toBe(DEPOSITORY);
      // S and L must come from ONE account_info read (atomic snapshot).
      expect(getAccountInfo).toHaveBeenCalledTimes(1);
      expect(getTransaction).not.toHaveBeenCalled();
    });

    it("reports EXPIRED when the ledger passed LLS before the sequence was consumed", async () => {
      // S = N (unconsumed), L = LLS + 1 → the payload can never be included.
      getAccountInfo.mockResolvedValue(accountInfo(WITHDRAWAL_N, WITHDRAWAL_LLS + 1));
      const message = await attestor.getDepositoryWithdrawalMessage(
        "xrp",
        encodedWithdrawal(),
      );
      expect(message.result.status).toBe(DepositoryWithdrawalStatus.EXPIRED);
      expect(getAccountInfo).toHaveBeenCalledTimes(1);
      expect(getTransaction).not.toHaveBeenCalled();
    });

    it("reports EXECUTED for the matching payload when the executing tx id is supplied", async () => {
      getAccountInfo.mockResolvedValue(accountInfo(WITHDRAWAL_N + 1, WITHDRAWAL_LLS));
      getTransaction.mockResolvedValue(withdrawalTx());
      const message = await attestor.getDepositoryWithdrawalMessage(
        "xrp",
        encodedWithdrawal(),
        WITHDRAWAL_TX_HASH,
      );
      expect(message.result.status).toBe(DepositoryWithdrawalStatus.EXECUTED);
    });

    it("reports EXPIRED when our payload was consumed by a tec (no delivery), without alerting", async () => {
      getAccountInfo.mockResolvedValue(accountInfo(WITHDRAWAL_N + 1, WITHDRAWAL_LLS));
      getTransaction.mockResolvedValue(
        withdrawalTx({
          meta: { TransactionResult: "tecUNFUNDED_PAYMENT" },
        }),
      );
      const message = await attestor.getDepositoryWithdrawalMessage(
        "xrp",
        encodedWithdrawal(),
        WITHDRAWAL_TX_HASH,
      );
      expect(message.result.status).toBe(DepositoryWithdrawalStatus.EXPIRED);
      // Identity still matches our payload → legitimate failure, not an anomaly.
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("reports EXPIRED for legitimate sequence-reuse after expiry (mismatch outside the window, no alert)", async () => {
      getAccountInfo.mockResolvedValue(accountInfo(WITHDRAWAL_N + 1, WITHDRAWAL_LLS + 50));
      // A different payload (paid to OTHER) consumed sequence N, validated AFTER
      // LLS → our payload had already expired; reuse is expected, no alert.
      getTransaction.mockResolvedValue(
        withdrawalTx({
          hash: OTHER_TX_HASH,
          Destination: OTHER,
          ledger_index: WITHDRAWAL_LLS + 20,
        }),
      );
      const message = await attestor.getDepositoryWithdrawalMessage(
        "xrp",
        encodedWithdrawal(),
        OTHER_TX_HASH,
      );
      expect(message.result.status).toBe(DepositoryWithdrawalStatus.EXPIRED);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("alerts and reports EXPIRED when a different payload consumed the sequence inside the window", async () => {
      getAccountInfo.mockResolvedValue(accountInfo(WITHDRAWAL_N + 1, WITHDRAWAL_LLS));
      // Different payload validated at ledger <= LLS → two signed payloads for
      // one sequence in-window = MPC anomaly.
      getTransaction.mockResolvedValue(
        withdrawalTx({
          hash: OTHER_TX_HASH,
          Destination: OTHER,
          ledger_index: WITHDRAWAL_LLS - 2,
        }),
      );
      const message = await attestor.getDepositoryWithdrawalMessage(
        "xrp",
        encodedWithdrawal(),
        OTHER_TX_HASH,
      );
      expect(message.result.status).toBe(DepositoryWithdrawalStatus.EXPIRED);
      expect(warnSpy).toHaveBeenCalledWith(
        "xrp-vm",
        expect.stringContaining("anomaly"),
      );
    });

    it("errors (never a terminal status) when the sequence is consumed but no transactionId is supplied", async () => {
      getAccountInfo.mockResolvedValue(accountInfo(WITHDRAWAL_N + 1, WITHDRAWAL_LLS));
      await expect(
        attestor.getDepositoryWithdrawalMessage("xrp", encodedWithdrawal()),
      ).rejects.toThrow("pass transactionId");
    });

    it("errors when the supplied tx did not consume the sequence (wrong sequence)", async () => {
      getAccountInfo.mockResolvedValue(accountInfo(WITHDRAWAL_N + 1, WITHDRAWAL_LLS));
      // On the depository but at a different sequence → not the consumer of N.
      getTransaction.mockResolvedValue(
        withdrawalTx({ Sequence: WITHDRAWAL_N + 5 }),
      );
      await expect(
        attestor.getDepositoryWithdrawalMessage(
          "xrp",
          encodedWithdrawal(),
          WITHDRAWAL_TX_HASH,
        ),
      ).rejects.toThrow("not the validated consumer");
    });

    it("errors when the supplied consuming tx is not yet validated", async () => {
      getAccountInfo.mockResolvedValue(accountInfo(WITHDRAWAL_N + 1, WITHDRAWAL_LLS));
      // Right account + sequence but not validated → not a usable consumer.
      getTransaction.mockResolvedValue(withdrawalTx({ validated: false }));
      await expect(
        attestor.getDepositoryWithdrawalMessage(
          "xrp",
          encodedWithdrawal(),
          WITHDRAWAL_TX_HASH,
        ),
      ).rejects.toThrow("not the validated consumer");
    });

    it("errors when the supplied consuming tx is not found", async () => {
      getAccountInfo.mockResolvedValue(accountInfo(WITHDRAWAL_N + 1, WITHDRAWAL_LLS));
      getTransaction.mockResolvedValue(null);
      await expect(
        attestor.getDepositoryWithdrawalMessage(
          "xrp",
          encodedWithdrawal(),
          WITHDRAWAL_TX_HASH,
        ),
      ).rejects.toThrow("not the validated consumer");
    });

    it("errors when the depository account is not found", async () => {
      getAccountInfo.mockResolvedValue(null);
      await expect(
        attestor.getDepositoryWithdrawalMessage("xrp", encodedWithdrawal()),
      ).rejects.toThrow("account not found");
    });

    it("errors when account_info is not from a validated ledger", async () => {
      getAccountInfo.mockResolvedValue(
        accountInfo(WITHDRAWAL_N, WITHDRAWAL_LLS - 10, { validated: false }),
      );
      await expect(
        attestor.getDepositoryWithdrawalMessage("xrp", encodedWithdrawal()),
      ).rejects.toThrow("not from a validated ledger");
    });

    it("rejects a withdrawal whose account is not the chain's depository", async () => {
      await expect(
        attestor.getDepositoryWithdrawalMessage(
          "xrp",
          encodedWithdrawal({ account: OTHER }),
        ),
      ).rejects.toThrow("does not match depository");
      expect(getAccountInfo).not.toHaveBeenCalled();
    });

    it("refuses a terminal verdict when a matching tx succeeded but delivered a different amount", async () => {
      getAccountInfo.mockResolvedValue(accountInfo(WITHDRAWAL_N + 1, WITHDRAWAL_LLS));
      getTransaction.mockResolvedValue(
        withdrawalTx({
          meta: { TransactionResult: "tesSUCCESS", delivered_amount: "1" },
        }),
      );
      await expect(
        attestor.getDepositoryWithdrawalMessage(
          "xrp",
          encodedWithdrawal(),
          WITHDRAWAL_TX_HASH,
        ),
      ).rejects.toThrow("delivered");
    });

    it("treats a DestinationTag mismatch as a different payload (EXPIRED)", async () => {
      getAccountInfo.mockResolvedValue(accountInfo(WITHDRAWAL_N + 1, WITHDRAWAL_LLS + 50));
      // Withdrawal pins tag 42; the consuming tx carries a different tag (out of
      // window → no anomaly alert).
      getTransaction.mockResolvedValue(
        withdrawalTx({ DestinationTag: 99, ledger_index: WITHDRAWAL_LLS + 20 }),
      );
      const message = await attestor.getDepositoryWithdrawalMessage(
        "xrp",
        encodedWithdrawal({ destinationTag: 42 }),
        WITHDRAWAL_TX_HASH,
      );
      expect(message.result.status).toBe(DepositoryWithdrawalStatus.EXPIRED);
    });

    it("reports EXPIRED (not EXECUTED) when the consumer has identical delivery but a different fee", async () => {
      getAccountInfo.mockResolvedValue(accountInfo(WITHDRAWAL_N + 1, WITHDRAWAL_LLS));
      // Same account/destination/amount/tag but Fee differs → different signing
      // hash → different withdrawalId. Delivery-only matching would attest this
      // EXECUTED (double-burn); the identity check rejects it. In-window → anomaly.
      getTransaction.mockResolvedValue(
        withdrawalTx({ Fee: "20", ledger_index: WITHDRAWAL_LLS - 2 }),
      );
      const message = await attestor.getDepositoryWithdrawalMessage(
        "xrp",
        encodedWithdrawal(),
        WITHDRAWAL_TX_HASH,
      );
      expect(message.result.status).toBe(DepositoryWithdrawalStatus.EXPIRED);
      expect(warnSpy).toHaveBeenCalledWith(
        "xrp-vm",
        expect.stringContaining("anomaly"),
      );
    });

    it("fails closed when the consuming tx cannot be rebuilt as a native withdrawal", async () => {
      getAccountInfo.mockResolvedValue(accountInfo(WITHDRAWAL_N + 1, WITHDRAWAL_LLS));
      // Issued-currency Amount → the signing-hash rebuild throws → non-terminal
      // error, never a (double-spendable) EXPIRED verdict.
      getTransaction.mockResolvedValue(withdrawalTx({ Amount: iouAmount }));
      await expect(
        attestor.getDepositoryWithdrawalMessage(
          "xrp",
          encodedWithdrawal(),
          WITHDRAWAL_TX_HASH,
        ),
      ).rejects.toThrow("not a reconstructable native-XRP withdrawal");
    });
  });

  describe("unsupported methods", () => {
    it("throws for solver calls", async () => {
      await expect(
        attestor.verifySolverCalls("xrp", TX_HASH, [], "0x"),
      ).rejects.toThrow("does not support solver calls");
    });
  });
});

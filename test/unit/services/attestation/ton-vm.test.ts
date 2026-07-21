// ABOUTME: Unit tests for TonVmAttestor — fill/refund (getSolverPaidAmount) and
// ABOUTME: deposit (getDepositoryDepositMessages) attestation paths.
import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import {
  Address,
  beginCell,
  Cell,
  internal,
  storeMessageRelaxed,
  TupleItem,
  TupleReader,
} from "@ton/core";
import {
  DecodedTonVmWithdrawal,
  DepositoryWithdrawalStatus,
  encodeWithdrawal,
  getDecodedWithdrawalId,
} from "@relay-protocol/settlement-sdk";

import { Chain } from "../../../../src/common/chains";
import {
  getMcBlockUtime,
  httpRpc,
  lookupMcBlockSeqnoByUtime,
} from "../../../../src/common/vm/ton-vm/rpc";
import { TonVmAttestor } from "../../../../src/services/attestation/vm/ton-vm";

const SOLVER_RAW =
  "0:aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
const RECIPIENT_RAW =
  "0:1122334455667788990011223344556677889900112233445566778899001122";
const OTHER_RAW =
  "0:9999999999999999999999999999999999999999999999999999999999999999";
const NATIVE_TON_RAW =
  "0:0000000000000000000000000000000000000000000000000000000000000000";
const DEPOSITORY_RAW =
  "0:7777777777777777777777777777777777777777777777777777777777777777";
const DEPOSITOR_RAW =
  "0:55556666777788889999aaaabbbbccccddddeeeeffff0000111122223333aaaa";

const TX_HASH_HEX =
  "abcd0123abcd0123abcd0123abcd0123abcd0123abcd0123abcd0123abcd0123";
const OTHER_TX_HASH_HEX =
  "11111111111111111111111111111111111111111111111111111111ffffffff";
const ORDER_ID =
  "0xdeadbeefcafef00d0011223344556677889900aabbccddeeff0011223344556";
// 64 hex chars (32 bytes) — used by deposit attestation which enforces the
// canonical orderId form. ORDER_ID above is a legacy 63-char fixture from
// fill tests (fill path uses string-compare, no length check).
const DEPOSIT_ORDER_ID =
  "0xdeadbeefcafef00d0011223344556677889900aabbccddeeff00112233445566";

jest.mock("../../../../src/common/chains", () => {
  const chains: Record<string, Chain> = {
    "ton-testnet": {
      id: "ton-testnet",
      vmType: "ton-vm",
      httpRpcUrl: "https://testnet.toncenter.com/api/v2/jsonRPC",
      hubChainId: "1",
      depository:
        "0:7777777777777777777777777777777777777777777777777777777777777777",
    },
    "ton-testnet-no-dep": {
      id: "ton-testnet-no-dep",
      vmType: "ton-vm",
      httpRpcUrl: "https://testnet.toncenter.com/api/v2/jsonRPC",
      hubChainId: "1",
    },
  };
  return {
    HUB_VM_TYPE: "hub-vm",
    HUB_CHAIN_ID: 0n,
    getChains: async () => chains,
    getHubChains: async () => [],
    getChain: async (chainId: string) => chains[chainId],
    getChainVmType: async (chainId: string) => chains[chainId].vmType,
    getChainHubChainId: async (chainId: string) => chains[chainId].hubChainId,
    getSdkChainsConfig: () =>
      Object.fromEntries(
        Object.values(chains).map((chain) => [chain.id, chain.vmType]),
      ),
  };
});

jest.mock("../../../../src/common/vm/ton-vm/rpc", () => ({
  httpRpc: jest.fn(),
  lookupMcBlockSeqnoByUtime: jest.fn(),
  getMcBlockUtime: jest.fn(),
}));

const buildCommentBody = (text: string): Cell =>
  beginCell().storeUint(0, 32).storeStringTail(text).endCell();

const buildOpaqueBody = (op: number): Cell =>
  beginCell().storeUint(op, 32).endCell();

interface MockMessageInput {
  destRaw: string;
  amount: bigint;
  body: Cell;
  internal?: boolean;
  bounce?: boolean;
  bounced?: boolean;
}

const buildMockMessage = ({
  destRaw,
  amount,
  body,
  internal = true,
  bounce = false,
  bounced = false,
}: MockMessageInput) => {
  const [wcStr, hashHex] = destRaw.split(":");
  const dest = new Address(parseInt(wcStr, 10), Buffer.from(hashHex, "hex"));
  return {
    info: internal
      ? {
          type: "internal" as const,
          dest,
          value: { coins: amount },
          bounce,
          bounced,
        }
      : { type: "external-out" as const },
    body,
  };
};

type ComputePhaseMock =
  | { type: "vm"; success: boolean; exitCode: number }
  | { type: "skipped"; reason: string };

const buildMockTx = ({
  hashHex,
  now,
  outMessages,
  inMessage,
  exitCode = 0,
  computeSuccess = true,
  aborted = false,
  actionPhase = { success: true, valid: true, resultCode: 0 } as
    | { success: boolean; valid: boolean; resultCode: number }
    | null
    | undefined,
  computePhase,
}: {
  hashHex: string;
  now: number;
  outMessages: ReturnType<typeof buildMockMessage>[];
  inMessage?: ReturnType<typeof buildInboundMessage> | null;
  exitCode?: number;
  computeSuccess?: boolean;
  aborted?: boolean;
  actionPhase?:
    | { success: boolean; valid: boolean; resultCode: number }
    | null
    | undefined;
  // Override the default `{type:"vm", success:computeSuccess, exitCode}` shape
  // — e.g. to test `skipped/no-state` (uninit dest, still success) or other
  // skip reasons.
  computePhase?: ComputePhaseMock;
}) => ({
  hash: () => Buffer.from(hashHex, "hex"),
  now,
  outMessages: { values: () => outMessages },
  outMessagesCount: outMessages.length,
  inMessage: inMessage === null ? undefined : inMessage,
  description: {
    type: "generic",
    aborted,
    computePhase: computePhase ?? {
      type: "vm",
      success: computeSuccess,
      exitCode,
    },
    actionPhase,
  },
});

interface InboundMessageInput {
  srcRaw: string;
  destRaw: string;
  amount: bigint;
  body: Cell;
  internal?: boolean;
}

const buildInboundMessage = ({
  srcRaw,
  destRaw,
  amount,
  body,
  internal = true,
  bounce = false,
}: InboundMessageInput & { bounce?: boolean }) => {
  const [srcWc, srcHash] = srcRaw.split(":");
  const [destWc, destHash] = destRaw.split(":");
  const src = new Address(parseInt(srcWc, 10), Buffer.from(srcHash, "hex"));
  const dest = new Address(
    parseInt(destWc, 10),
    Buffer.from(destHash, "hex"),
  );
  return {
    info: internal
      ? {
          type: "internal" as const,
          src,
          dest,
          value: { coins: amount },
          bounce,
          bounced: false,
        }
      : { type: "external-in" as const, dest },
    body,
  };
};

const setupRpcMock = (
  recentTxs: unknown[],
  options?: {
    directTx?: unknown | null
    directThrows?: boolean
    // Override masterchain seqno values for the finality check.
    // Default: latest=1000, txMc=100 → 900 blocks elapsed → always passes
    // finality. Override to force "not yet finalized" failures.
    latestMcSeqno?: number
    txMcSeqno?: number
    // Force lookupMcBlockSeqnoByUtime to throw (e.g., simulate "future
    // unixtime not yet finalized" error from toncenter).
    lookupBlockThrows?: boolean
  },
) => {
  const getTransaction = options?.directThrows
    ? jest.fn<() => Promise<unknown>>().mockRejectedValue(new Error("rpc down"))
    : jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(options?.directTx ?? null)

  const latestMcSeqno = options?.latestMcSeqno ?? 1000
  const txMcSeqno = options?.txMcSeqno ?? 100

  const getMasterchainInfo = jest.fn<() => Promise<unknown>>().mockResolvedValue({
    workchain: -1,
    shard: "-9223372036854775808",
    initSeqno: 0,
    latestSeqno: latestMcSeqno,
  })

  const mockLookup = lookupMcBlockSeqnoByUtime as jest.MockedFunction<
    typeof lookupMcBlockSeqnoByUtime
  >
  if (options?.lookupBlockThrows) {
    mockLookup.mockRejectedValue(
      new Error("mc block at unixtime ... not yet finalized"),
    )
  } else {
    mockLookup.mockResolvedValue(txMcSeqno)
  }

  ;(httpRpc as jest.Mock).mockImplementation(() =>
    Promise.resolve({
      client: {
        getTransactions: jest
          .fn<() => Promise<unknown[]>>()
          .mockResolvedValue(recentTxs),
        getTransaction,
        getMasterchainInfo,
      },
      chain: {
        id: "ton-testnet",
        additionalData: {},
      },
    }),
  );
};

const basePayment = {
  currency: NATIVE_TON_RAW,
  recipient: RECIPIENT_RAW,
  orderId: ORDER_ID,
  extraData: "0x",
  deadline: 9999999999,
};

const baseHints = { "ton-vm": { solverAddress: SOLVER_RAW } } as const;

describe("TonVmAttestor", () => {
  describe("getSolverPaidAmount", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("returns the paid amount for a matching native TON fill", async () => {
      const PAID = 5_000_000_000n;
      setupRpcMock([
        buildMockTx({
          hashHex: TX_HASH_HEX,
          now: 1_700_000_000,
          outMessages: [
            buildMockMessage({
              destRaw: RECIPIENT_RAW,
              amount: PAID,
              body: buildCommentBody(ORDER_ID),
            }),
          ],
        }),
      ]);

      const result = await new TonVmAttestor().getSolverPaidAmount(
        "ton-testnet",
        TX_HASH_HEX,
        basePayment,
        baseHints,
      );
      expect(result).toBe(PAID);
    });

    it("uses direct (addr, lt, hash) lookup when lt hint is supplied", async () => {
      const PAID = 7_500_000_000n;
      const targetTx = buildMockTx({
        hashHex: TX_HASH_HEX,
        now: 1_700_000_000,
        outMessages: [
          buildMockMessage({
            destRaw: RECIPIENT_RAW,
            amount: PAID,
            body: buildCommentBody(ORDER_ID),
          }),
        ],
      })
      // Recent scan list deliberately EMPTY — proves we didn't fall back to it.
      setupRpcMock([], { directTx: targetTx })

      const result = await new TonVmAttestor().getSolverPaidAmount(
        "ton-testnet",
        TX_HASH_HEX,
        basePayment,
        {
          "ton-vm": {
            solverAddress: SOLVER_RAW,
            lt: "12345678",
          },
        },
      )
      expect(result).toBe(PAID)
    })

    it("falls back to history scan when lt hint is omitted", async () => {
      // No `lt` in hints — must scan recent txs to find a match.
      const PAID = 3_000_000_000n
      setupRpcMock(
        [
          buildMockTx({
            hashHex: TX_HASH_HEX,
            now: 1_700_000_000,
            outMessages: [
              buildMockMessage({
                destRaw: RECIPIENT_RAW,
                amount: PAID,
                body: buildCommentBody(ORDER_ID),
              }),
            ],
          }),
        ],
        // Direct mock should never be called (no lt) — return null defensively.
        { directTx: null },
      )

      const result = await new TonVmAttestor().getSolverPaidAmount(
        "ton-testnet",
        TX_HASH_HEX,
        basePayment,
        baseHints,
      )
      expect(result).toBe(PAID)
    })

    it("falls back to history scan when direct lookup returns null", async () => {
      // Caller supplied stale lt, direct lookup misses; scan should still find it.
      const PAID = 1_500_000_000n
      setupRpcMock(
        [
          buildMockTx({
            hashHex: TX_HASH_HEX,
            now: 1_700_000_000,
            outMessages: [
              buildMockMessage({
                destRaw: RECIPIENT_RAW,
                amount: PAID,
                body: buildCommentBody(ORDER_ID),
              }),
            ],
          }),
        ],
        { directTx: null },
      )

      const result = await new TonVmAttestor().getSolverPaidAmount(
        "ton-testnet",
        TX_HASH_HEX,
        basePayment,
        {
          "ton-vm": {
            solverAddress: SOLVER_RAW,
            lt: "99999999",
          },
        },
      )
      expect(result).toBe(PAID)
    })

    it("falls back to history scan when direct lookup throws (RPC error)", async () => {
      const PAID = 800_000_000n
      setupRpcMock(
        [
          buildMockTx({
            hashHex: TX_HASH_HEX,
            now: 1_700_000_000,
            outMessages: [
              buildMockMessage({
                destRaw: RECIPIENT_RAW,
                amount: PAID,
                body: buildCommentBody(ORDER_ID),
              }),
            ],
          }),
        ],
        { directThrows: true },
      )

      const result = await new TonVmAttestor().getSolverPaidAmount(
        "ton-testnet",
        TX_HASH_HEX,
        basePayment,
        {
          "ton-vm": {
            solverAddress: SOLVER_RAW,
            lt: "12345678",
          },
        },
      )
      expect(result).toBe(PAID)
    })

    it("rejects a bounceable outbound msg (silently refunded if recipient is uninit)", async () => {
      // Even though dest hash + workchain + comment all match payment, a
      // bounceable msg can be auto-refunded by TVM in a later tx when the
      // recipient is uninitialized — the value.coins field is not authoritative
      // for "recipient received this much" in that case. Treat as not-paid.
      setupRpcMock([
        buildMockTx({
          hashHex: TX_HASH_HEX,
          now: 1_700_000_000,
          outMessages: [
            buildMockMessage({
              destRaw: RECIPIENT_RAW,
              amount: 5_000_000_000n,
              body: buildCommentBody(ORDER_ID),
              bounce: true,
            }),
          ],
        }),
      ]);

      await expect(
        new TonVmAttestor().getSolverPaidAmount(
          "ton-testnet",
          TX_HASH_HEX,
          basePayment,
          baseHints,
        ),
      ).rejects.toThrow(/Could not detect payment/i);
    });

    it("rejects a bounced outbound msg (defensive — bounced refunds are not fills)", async () => {
      setupRpcMock([
        buildMockTx({
          hashHex: TX_HASH_HEX,
          now: 1_700_000_000,
          outMessages: [
            buildMockMessage({
              destRaw: RECIPIENT_RAW,
              amount: 5_000_000_000n,
              body: buildCommentBody(ORDER_ID),
              bounced: true,
            }),
          ],
        }),
      ]);

      await expect(
        new TonVmAttestor().getSolverPaidAmount(
          "ton-testnet",
          TX_HASH_HEX,
          basePayment,
          baseHints,
        ),
      ).rejects.toThrow(/Could not detect payment/i);
    });

    it("sums multiple matching outbound messages (split fill)", async () => {
      // A single tx is free to emit multiple internal transfers to the same
      // recipient with the same orderId comment — the attestor must sum
      // value.coins across all of them, not just return the first.
      const PART_A = 4_000_000_000n;
      const PART_B = 6_000_000_000n;
      setupRpcMock([
        buildMockTx({
          hashHex: TX_HASH_HEX,
          now: 1_700_000_000,
          outMessages: [
            buildMockMessage({
              destRaw: RECIPIENT_RAW,
              amount: PART_A,
              body: buildCommentBody(ORDER_ID),
            }),
            buildMockMessage({
              destRaw: RECIPIENT_RAW,
              amount: PART_B,
              body: buildCommentBody(ORDER_ID),
            }),
          ],
        }),
      ]);

      const result = await new TonVmAttestor().getSolverPaidAmount(
        "ton-testnet",
        TX_HASH_HEX,
        basePayment,
        baseHints,
      );
      expect(result).toBe(PART_A + PART_B);
    });

    it("only counts non-bounceable msgs when a fill mixes bounce + non-bounce", async () => {
      // Defensive: a tx with one bounce=true + one bounce=false matching the
      // same recipient/orderId returns only the non-bounceable value (the
      // bounceable could refund out from under us).
      const REAL_PAYMENT = 3_000_000_000n;
      setupRpcMock([
        buildMockTx({
          hashHex: TX_HASH_HEX,
          now: 1_700_000_000,
          outMessages: [
            buildMockMessage({
              destRaw: RECIPIENT_RAW,
              amount: 7_777_777_777n,
              body: buildCommentBody(ORDER_ID),
              bounce: true,
            }),
            buildMockMessage({
              destRaw: RECIPIENT_RAW,
              amount: REAL_PAYMENT,
              body: buildCommentBody(ORDER_ID),
              bounce: false,
            }),
          ],
        }),
      ]);

      const result = await new TonVmAttestor().getSolverPaidAmount(
        "ton-testnet",
        TX_HASH_HEX,
        basePayment,
        baseHints,
      );
      expect(result).toBe(REAL_PAYMENT);
    });

    it("ignores unrelated outbound messages and picks the matching one", async () => {
      const PAID = 250_000_000n;
      setupRpcMock([
        buildMockTx({
          hashHex: TX_HASH_HEX,
          now: 1_700_000_000,
          outMessages: [
            // External-out (e.g. event log) — ignored
            buildMockMessage({
              destRaw: OTHER_RAW,
              amount: 0n,
              body: buildCommentBody(ORDER_ID),
              internal: false,
            }),
            // Wrong recipient
            buildMockMessage({
              destRaw: OTHER_RAW,
              amount: 999n,
              body: buildCommentBody(ORDER_ID),
            }),
            // Right recipient, wrong orderId
            buildMockMessage({
              destRaw: RECIPIENT_RAW,
              amount: 1000n,
              body: buildCommentBody("other-order"),
            }),
            // Right recipient + right orderId
            buildMockMessage({
              destRaw: RECIPIENT_RAW,
              amount: PAID,
              body: buildCommentBody(ORDER_ID),
            }),
          ],
        }),
      ]);

      const result = await new TonVmAttestor().getSolverPaidAmount(
        "ton-testnet",
        TX_HASH_HEX,
        basePayment,
        baseHints,
      );
      expect(result).toBe(PAID);
    });

    it("works for refund (recipient = depositor) — same code path", async () => {
      const PAID = 12_345n;
      setupRpcMock([
        buildMockTx({
          hashHex: TX_HASH_HEX,
          now: 1_700_000_000,
          outMessages: [
            buildMockMessage({
              destRaw: OTHER_RAW, // depositor address
              amount: PAID,
              body: buildCommentBody(ORDER_ID),
            }),
          ],
        }),
      ]);

      const result = await new TonVmAttestor().getSolverPaidAmount(
        "ton-testnet",
        TX_HASH_HEX,
        { ...basePayment, recipient: OTHER_RAW },
        baseHints,
      );
      expect(result).toBe(PAID);
    });

    it("rejects when RPC returns a tx with mismatched hash on direct lookup (defense-in-depth)", async () => {
      // hints.lt forces direct getTransaction path. Mock returns a tx whose
      // computed hash does NOT match transactionId — must throw "mismatched
      // hash" rather than silently attest the wrong tx.
      const wrongHashTx = buildMockTx({
        hashHex: OTHER_TX_HASH_HEX, // intentionally different from TX_HASH_HEX
        now: 1_700_000_000,
        outMessages: [
          buildMockMessage({
            destRaw: RECIPIENT_RAW,
            amount: 1n,
            body: buildCommentBody(ORDER_ID),
          }),
        ],
      });
      setupRpcMock([], { directTx: wrongHashTx });

      await expect(
        new TonVmAttestor().getSolverPaidAmount(
          "ton-testnet",
          TX_HASH_HEX,
          basePayment,
          {
            "ton-vm": { solverAddress: SOLVER_RAW, lt: "12345678" },
          },
        ),
      ).rejects.toThrow(/mismatched hash/i);
    });

    it("matches orderId case-insensitively against the text comment", async () => {
      // Solver-side comment is uppercase; payment.orderId (canonical SDK
      // form) is lowercase. Match must succeed.
      const PAID = 2_000_000_000n;
      setupRpcMock([
        buildMockTx({
          hashHex: TX_HASH_HEX,
          now: 1_700_000_000,
          outMessages: [
            buildMockMessage({
              destRaw: RECIPIENT_RAW,
              amount: PAID,
              body: buildCommentBody(ORDER_ID.toUpperCase()),
            }),
          ],
        }),
      ]);

      const result = await new TonVmAttestor().getSolverPaidAmount(
        "ton-testnet",
        TX_HASH_HEX,
        basePayment,
        baseHints,
      );
      expect(result).toBe(PAID);
    });

    it("error message hints when matching outbound msgs were skipped solely due to bounce=true", async () => {
      // Matching recipient + orderId + workchain, but bounceable. Error
      // should include the bounceable-count hint to ease solver-side debugging.
      setupRpcMock([
        buildMockTx({
          hashHex: TX_HASH_HEX,
          now: 1_700_000_000,
          outMessages: [
            buildMockMessage({
              destRaw: RECIPIENT_RAW,
              amount: 5_000_000_000n,
              body: buildCommentBody(ORDER_ID),
              bounce: true,
            }),
          ],
        }),
      ]);

      await expect(
        new TonVmAttestor().getSolverPaidAmount(
          "ton-testnet",
          TX_HASH_HEX,
          basePayment,
          baseHints,
        ),
      ).rejects.toThrow(/bounceable/i);
    });

    it("rejects when hints.ton-vm.solverAddress is missing", async () => {
      await expect(
        new TonVmAttestor().getSolverPaidAmount(
          "ton-testnet",
          TX_HASH_HEX,
          basePayment,
          undefined,
        ),
      ).rejects.toThrow(/solverAddress/i);
    });

    it("rejects when transactionId is not 64 hex chars", async () => {
      await expect(
        new TonVmAttestor().getSolverPaidAmount(
          "ton-testnet",
          "deadbeef",
          basePayment,
          baseHints,
        ),
      ).rejects.toThrow(/64 hex/i);
    });

    it("rejects when no tx with the given hash exists on the solver wallet", async () => {
      setupRpcMock([
        buildMockTx({
          hashHex: OTHER_TX_HASH_HEX,
          now: 1_700_000_000,
          outMessages: [],
        }),
      ]);

      await expect(
        new TonVmAttestor().getSolverPaidAmount(
          "ton-testnet",
          TX_HASH_HEX,
          basePayment,
          baseHints,
        ),
      ).rejects.toThrow(/Missing transaction/i);
    });

    it("rejects a reverted tx (non-zero compute exit code)", async () => {
      setupRpcMock([
        buildMockTx({
          hashHex: TX_HASH_HEX,
          now: 1_700_000_000,
          outMessages: [
            buildMockMessage({
              destRaw: RECIPIENT_RAW,
              amount: 1n,
              body: buildCommentBody(ORDER_ID),
            }),
          ],
          exitCode: 7, // invalid opcode
        }),
      ]);

      await expect(
        new TonVmAttestor().getSolverPaidAmount(
          "ton-testnet",
          TX_HASH_HEX,
          basePayment,
          baseHints,
        ),
      ).rejects.toThrow(/Reverted/i);
    });

    it("rejects a tx executed after the deadline", async () => {
      // tx.now far in the past (so finalization check passes), but deadline
      // is even earlier so the deadline check is the one that fires.
      setupRpcMock([
        buildMockTx({
          hashHex: TX_HASH_HEX,
          now: 1_700_000_000,
          outMessages: [
            buildMockMessage({
              destRaw: RECIPIENT_RAW,
              amount: 1n,
              body: buildCommentBody(ORDER_ID),
            }),
          ],
        }),
      ]);

      await expect(
        new TonVmAttestor().getSolverPaidAmount(
          "ton-testnet",
          TX_HASH_HEX,
          { ...basePayment, deadline: 1_699_999_999 },
          baseHints,
        ),
      ).rejects.toThrow(/after deadline/i);
    });

    it("rejects a tx whose masterchain block hasn't been followed by enough blocks", async () => {
      // Latest masterchain seqno is only 1 block past tx's masterchain block —
      // less than the 3-block default finality buffer. Must reject.
      setupRpcMock(
        [
          buildMockTx({
            hashHex: TX_HASH_HEX,
            now: 1_700_000_000,
            outMessages: [
              buildMockMessage({
                destRaw: RECIPIENT_RAW,
                amount: 1n,
                body: buildCommentBody(ORDER_ID),
              }),
            ],
          }),
        ],
        { latestMcSeqno: 101, txMcSeqno: 100 },
      );

      await expect(
        new TonVmAttestor().getSolverPaidAmount(
          "ton-testnet",
          TX_HASH_HEX,
          basePayment,
          baseHints,
        ),
      ).rejects.toThrow(/not yet finalized/i);
    });

    it("propagates lookupBlock errors (e.g., not yet finalized on toncenter)", async () => {
      setupRpcMock(
        [
          buildMockTx({
            hashHex: TX_HASH_HEX,
            now: 1_700_000_000,
            outMessages: [
              buildMockMessage({
                destRaw: RECIPIENT_RAW,
                amount: 1n,
                body: buildCommentBody(ORDER_ID),
              }),
            ],
          }),
        ],
        { lookupBlockThrows: true },
      );

      await expect(
        new TonVmAttestor().getSolverPaidAmount(
          "ton-testnet",
          TX_HASH_HEX,
          basePayment,
          baseHints,
        ),
      ).rejects.toThrow(/not yet finalized/i);
    });

    it("rejects a tx whose top-level description is aborted", async () => {
      // compute phase exit code 0 but description.aborted = true — happens
      // when a later phase fails. Must reject.
      setupRpcMock([
        buildMockTx({
          hashHex: TX_HASH_HEX,
          now: 1_700_000_000,
          aborted: true,
          outMessages: [
            buildMockMessage({
              destRaw: RECIPIENT_RAW,
              amount: 1n,
              body: buildCommentBody(ORDER_ID),
            }),
          ],
        }),
      ]);

      await expect(
        new TonVmAttestor().getSolverPaidAmount(
          "ton-testnet",
          TX_HASH_HEX,
          basePayment,
          baseHints,
        ),
      ).rejects.toThrow(/Reverted/i);
    });

    it("rejects a tx whose action phase failed (resultCode != 0)", async () => {
      // compute phase succeeded but action phase failed (e.g. RESERVE failed,
      // outbound msgs never actually emitted). Must reject.
      setupRpcMock([
        buildMockTx({
          hashHex: TX_HASH_HEX,
          now: 1_700_000_000,
          outMessages: [
            buildMockMessage({
              destRaw: RECIPIENT_RAW,
              amount: 1n,
              body: buildCommentBody(ORDER_ID),
            }),
          ],
          actionPhase: { success: false, valid: false, resultCode: 35 },
        }),
      ]);

      await expect(
        new TonVmAttestor().getSolverPaidAmount(
          "ton-testnet",
          TX_HASH_HEX,
          basePayment,
          baseHints,
        ),
      ).rejects.toThrow(/Reverted/i);
    });

    it("accepts a tx with computePhase.type=skipped + reason=no-state (send to uninit address)", async () => {
      // Sending TON to an uninitialized address: compute phase is skipped with
      // reason "no-state" but the outbound transfer still delivered. NOT a revert.
      const PAID = 600_000_000n;
      setupRpcMock([
        buildMockTx({
          hashHex: TX_HASH_HEX,
          now: 1_700_000_000,
          outMessages: [
            buildMockMessage({
              destRaw: RECIPIENT_RAW,
              amount: PAID,
              body: buildCommentBody(ORDER_ID),
            }),
          ],
          computePhase: { type: "skipped", reason: "no-state" },
        }),
      ]);

      const result = await new TonVmAttestor().getSolverPaidAmount(
        "ton-testnet",
        TX_HASH_HEX,
        basePayment,
        baseHints,
      );
      expect(result).toBe(PAID);
    });

    it("accepts a tx with aborted=true + computePhase=skipped/no-state (uninit recipient empirically on testnet)", async () => {
      // Real testnet shape: deposit/fill to an uninit wallet sets aborted=true
      // alongside compute=skipped/no-state. Value IS credited.
      const PAID = 100_000_000n;
      setupRpcMock([
        buildMockTx({
          hashHex: TX_HASH_HEX,
          now: 1_700_000_000,
          aborted: true,
          actionPhase: null,
          computePhase: { type: "skipped", reason: "no-state" },
          outMessages: [
            buildMockMessage({
              destRaw: RECIPIENT_RAW,
              amount: PAID,
              body: buildCommentBody(ORDER_ID),
            }),
          ],
        }),
      ]);

      const result = await new TonVmAttestor().getSolverPaidAmount(
        "ton-testnet",
        TX_HASH_HEX,
        basePayment,
        baseHints,
      );
      expect(result).toBe(PAID);
    });

    it("rejects a tx with computePhase.type=skipped + reason other than no-state", async () => {
      setupRpcMock([
        buildMockTx({
          hashHex: TX_HASH_HEX,
          now: 1_700_000_000,
          outMessages: [
            buildMockMessage({
              destRaw: RECIPIENT_RAW,
              amount: 1n,
              body: buildCommentBody(ORDER_ID),
            }),
          ],
          computePhase: { type: "skipped", reason: "bad-state" },
        }),
      ]);

      await expect(
        new TonVmAttestor().getSolverPaidAmount(
          "ton-testnet",
          TX_HASH_HEX,
          basePayment,
          baseHints,
        ),
      ).rejects.toThrow(/Reverted/i);
    });

    it("rejects a tx with an unknown computePhase.type (defensive)", async () => {
      setupRpcMock([
        buildMockTx({
          hashHex: TX_HASH_HEX,
          now: 1_700_000_000,
          outMessages: [
            buildMockMessage({
              destRaw: RECIPIENT_RAW,
              amount: 1n,
              body: buildCommentBody(ORDER_ID),
            }),
          ],
          // @ts-expect-error -- intentionally testing a shape outside the TS union
          computePhase: { type: "unexpected-future-phase-type" },
        }),
      ]);

      await expect(
        new TonVmAttestor().getSolverPaidAmount(
          "ton-testnet",
          TX_HASH_HEX,
          basePayment,
          baseHints,
        ),
      ).rejects.toThrow(/Reverted/i);
    });

    it("accepts a tx with actionPhase=null (matches real mainnet aborted-but-here we re-pass-cleanly shape)", async () => {
      // Real mainnet txs carry `actionPhase: null` (not undefined) when no
      // action phase ran. Verify the truthy-check handles null identically
      // to undefined. Compute phase clean + aborted=false → not reverted.
      const PAID = 250_000_000n;
      setupRpcMock([
        buildMockTx({
          hashHex: TX_HASH_HEX,
          now: 1_700_000_000,
          outMessages: [
            buildMockMessage({
              destRaw: RECIPIENT_RAW,
              amount: PAID,
              body: buildCommentBody(ORDER_ID),
            }),
          ],
          actionPhase: null,
        }),
      ]);

      const result = await new TonVmAttestor().getSolverPaidAmount(
        "ton-testnet",
        TX_HASH_HEX,
        basePayment,
        baseHints,
      );
      expect(result).toBe(PAID);
    });

    it("rejects a tx whose compute phase reports success=false even with exitCode 0", async () => {
      // Defense-in-depth: success and exitCode are independent in the TL-B
      // spec; checking both prevents weird states from sneaking through.
      setupRpcMock([
        buildMockTx({
          hashHex: TX_HASH_HEX,
          now: 1_700_000_000,
          computeSuccess: false,
          outMessages: [
            buildMockMessage({
              destRaw: RECIPIENT_RAW,
              amount: 1n,
              body: buildCommentBody(ORDER_ID),
            }),
          ],
        }),
      ]);

      await expect(
        new TonVmAttestor().getSolverPaidAmount(
          "ton-testnet",
          TX_HASH_HEX,
          basePayment,
          baseHints,
        ),
      ).rejects.toThrow(/Reverted/i);
    });

    it("rejects a non-native currency (jetton out of v1 scope)", async () => {
      setupRpcMock([
        buildMockTx({
          hashHex: TX_HASH_HEX,
          now: 1_700_000_000,
          outMessages: [
            buildMockMessage({
              destRaw: RECIPIENT_RAW,
              amount: 1n,
              body: buildCommentBody(ORDER_ID),
            }),
          ],
        }),
      ]);

      await expect(
        new TonVmAttestor().getSolverPaidAmount(
          "ton-testnet",
          TX_HASH_HEX,
          { ...basePayment, currency: OTHER_RAW },
          baseHints,
        ),
      ).rejects.toThrow(/Unsupported currency/i);
    });

    it("rejects when the outbound msg to recipient has no text comment", async () => {
      setupRpcMock([
        buildMockTx({
          hashHex: TX_HASH_HEX,
          now: 1_700_000_000,
          outMessages: [
            buildMockMessage({
              destRaw: RECIPIENT_RAW,
              amount: 1n,
              // jetton-transfer-like opcode, not 0x00000000 comment
              body: buildOpaqueBody(0xf8a7ea5),
            }),
          ],
        }),
      ]);

      await expect(
        new TonVmAttestor().getSolverPaidAmount(
          "ton-testnet",
          TX_HASH_HEX,
          basePayment,
          baseHints,
        ),
      ).rejects.toThrow(/Could not detect payment/i);
    });

    it("rejects when outbound dest has matching hash but wrong workchain (-1 masterchain collision)", async () => {
      // Same 32-byte hash as RECIPIENT_RAW but on workchain -1; must NOT be
      // counted as a match because the on-chain bytes32 contract assumption
      // is workchain 0 only.
      const [, recipientHashHex] = RECIPIENT_RAW.split(":");
      const masterchainDest = new Address(
        -1,
        Buffer.from(recipientHashHex, "hex"),
      );
      setupRpcMock([
        {
          hash: () => Buffer.from(TX_HASH_HEX, "hex"),
          now: 1_700_000_000,
          outMessages: {
            values: () => [
              {
                info: {
                  type: "internal",
                  dest: masterchainDest,
                  value: { coins: 1n },
                },
                body: buildCommentBody(ORDER_ID),
              },
            ],
          },
          description: {
            type: "generic",
            computePhase: { type: "vm", exitCode: 0 },
          },
        },
      ]);

      await expect(
        new TonVmAttestor().getSolverPaidAmount(
          "ton-testnet",
          TX_HASH_HEX,
          basePayment,
          baseHints,
        ),
      ).rejects.toThrow(/Could not detect payment/i);
    });

    it("rejects when the comment is present but doesn't match orderId", async () => {
      setupRpcMock([
        buildMockTx({
          hashHex: TX_HASH_HEX,
          now: 1_700_000_000,
          outMessages: [
            buildMockMessage({
              destRaw: RECIPIENT_RAW,
              amount: 1n,
              body: buildCommentBody("0xnotthematchingorderid"),
            }),
          ],
        }),
      ]);

      await expect(
        new TonVmAttestor().getSolverPaidAmount(
          "ton-testnet",
          TX_HASH_HEX,
          basePayment,
          baseHints,
        ),
      ).rejects.toThrow(/Could not detect payment/i);
    });
  });

  describe("getDepositoryDepositMessages", () => {
    const DEPOSIT_LT = "12345678";
    const depositHints = { "ton-vm": { lt: DEPOSIT_LT } } as const;
    const AMOUNT = 3_000_000_000n;

    beforeEach(() => {
      jest.clearAllMocks();
    });

    const buildDepositTx = (
      overrides: Partial<Parameters<typeof buildMockTx>[0]> & {
        srcRaw?: string;
        destRaw?: string;
        amount?: bigint;
        body?: Cell;
        internal?: boolean;
        bounce?: boolean;
      } = {},
    ) => {
      const {
        srcRaw = DEPOSITOR_RAW,
        destRaw = DEPOSITORY_RAW,
        amount = AMOUNT,
        body = buildCommentBody(DEPOSIT_ORDER_ID),
        internal = true,
        bounce = false,
        ...txOverrides
      } = overrides;
      return buildMockTx({
        hashHex: TX_HASH_HEX,
        now: 1_700_000_000,
        outMessages: [],
        inMessage: buildInboundMessage({
          srcRaw,
          destRaw,
          amount,
          body,
          internal,
          bounce,
        }),
        ...txOverrides,
      });
    };

    it("ignores bounce=true inbound (TVM auto-refund would double-credit)", async () => {
      setupRpcMock([], { directTx: buildDepositTx({ bounce: true }) });

      const result = await new TonVmAttestor().getDepositoryDepositMessages(
        "ton-testnet",
        TX_HASH_HEX,
        depositHints,
      );
      expect(result).toEqual([]);
    });

    it("returns a deposit message for a happy-path inbound transfer", async () => {
      setupRpcMock([], { directTx: buildDepositTx() });

      const result = await new TonVmAttestor().getDepositoryDepositMessages(
        "ton-testnet",
        TX_HASH_HEX,
        depositHints,
      );

      expect(result).toHaveLength(1);
      const msg = result[0];
      expect(msg.data).toEqual({
        chainId: "ton-testnet",
        transactionId: TX_HASH_HEX,
      });
      expect(msg.result.depository).toBe(DEPOSITORY_RAW);
      expect(msg.result.depositor).toBe(DEPOSITOR_RAW);
      expect(msg.result.amount).toBe(AMOUNT.toString());
      expect(msg.result.depositId).toBe(DEPOSIT_ORDER_ID.toLowerCase());
      expect(msg.extraData.timestamp).toBe("1700000000");
      expect(msg.result.onchainId).toEqual(expect.any(String));
    });

    it("throws when hints.lt is missing", async () => {
      setupRpcMock([]);
      await expect(
        new TonVmAttestor().getDepositoryDepositMessages(
          "ton-testnet",
          TX_HASH_HEX,
        ),
      ).rejects.toThrow(/Missing required hint: ton-vm\.lt/);
    });

    it("throws when transaction id is not 64 hex chars", async () => {
      setupRpcMock([]);
      await expect(
        new TonVmAttestor().getDepositoryDepositMessages(
          "ton-testnet",
          "0xnothex",
          depositHints,
        ),
      ).rejects.toThrow(/Invalid TON transaction id/);
    });

    it("throws when chain has no depository configured", async () => {
      setupRpcMock([]);
      await expect(
        new TonVmAttestor().getDepositoryDepositMessages(
          "ton-testnet-no-dep",
          TX_HASH_HEX,
          depositHints,
        ),
      ).rejects.toThrow(/Chain has no depository configured/);
    });

    it("throws when RPC returns null for the (addr, lt, hash) cursor", async () => {
      setupRpcMock([], { directTx: null });
      await expect(
        new TonVmAttestor().getDepositoryDepositMessages(
          "ton-testnet",
          TX_HASH_HEX,
          depositHints,
        ),
      ).rejects.toThrow(/Missing transaction/);
    });

    it("throws when RPC returns a tx with a mismatched hash", async () => {
      setupRpcMock([], {
        directTx: buildDepositTx({ hashHex: OTHER_TX_HASH_HEX }),
      });
      await expect(
        new TonVmAttestor().getDepositoryDepositMessages(
          "ton-testnet",
          TX_HASH_HEX,
          depositHints,
        ),
      ).rejects.toThrow(/RPC returned tx with mismatched hash/);
    });

    it("throws on a reverted tx (aborted=true)", async () => {
      setupRpcMock([], { directTx: buildDepositTx({ aborted: true }) });
      await expect(
        new TonVmAttestor().getDepositoryDepositMessages(
          "ton-testnet",
          TX_HASH_HEX,
          depositHints,
        ),
      ).rejects.toThrow(/Reverted transaction/);
    });

    it("throws when tx is not yet finalized", async () => {
      setupRpcMock([], {
        directTx: buildDepositTx(),
        latestMcSeqno: 102,
        txMcSeqno: 100,
      });
      await expect(
        new TonVmAttestor().getDepositoryDepositMessages(
          "ton-testnet",
          TX_HASH_HEX,
          depositHints,
        ),
      ).rejects.toThrow(/not yet finalized/);
    });

    it("returns [] for an external-in inMessage (wallet command, not a deposit)", async () => {
      setupRpcMock([], {
        directTx: buildDepositTx({ internal: false }),
      });
      const result = await new TonVmAttestor().getDepositoryDepositMessages(
        "ton-testnet",
        TX_HASH_HEX,
        depositHints,
      );
      expect(result).toEqual([]);
    });

    it("returns [] when dest does not match the configured depository", async () => {
      setupRpcMock([], {
        directTx: buildDepositTx({ destRaw: OTHER_RAW }),
      });
      const result = await new TonVmAttestor().getDepositoryDepositMessages(
        "ton-testnet",
        TX_HASH_HEX,
        depositHints,
      );
      expect(result).toEqual([]);
    });

    it("returns [] when src is not on workchain 0", async () => {
      setupRpcMock([], {
        directTx: buildDepositTx({
          srcRaw: `-1:${DEPOSITOR_RAW.split(":")[1]}`,
        }),
      });
      const result = await new TonVmAttestor().getDepositoryDepositMessages(
        "ton-testnet",
        TX_HASH_HEX,
        depositHints,
      );
      expect(result).toEqual([]);
    });

    it("rejects a jetton-transfer-notification body as not a Relay deposit (F-013)", async () => {
      // 0x7362d09c = TEP-74 jetton transfer notification opcode. Otherwise
      // this tx would be attested as a small native-TON deposit from the
      // depository's jetton-wallet alias, which is unspendable on hub.
      setupRpcMock([], {
        directTx: buildDepositTx({ body: buildOpaqueBody(0x7362d09c) }),
      });
      const result = await new TonVmAttestor().getDepositoryDepositMessages(
        "ton-testnet",
        TX_HASH_HEX,
        depositHints,
      );
      expect(result).toEqual([]);
    });

    it("rejects any non-zero opcode body as not a Relay deposit", async () => {
      setupRpcMock([], {
        directTx: buildDepositTx({ body: buildOpaqueBody(0x12345678) }),
      });
      const result = await new TonVmAttestor().getDepositoryDepositMessages(
        "ton-testnet",
        TX_HASH_HEX,
        depositHints,
      );
      expect(result).toEqual([]);
    });

    it("accepts an empty-body inbound (no comment) as a zeroHash deposit", async () => {
      // User sending native TON with no body is still a Relay deposit (just
      // without orderId binding) — depositId falls back to zeroHash.
      const emptyBody = beginCell().endCell();
      setupRpcMock([], {
        directTx: buildDepositTx({ body: emptyBody }),
      });
      const result = await new TonVmAttestor().getDepositoryDepositMessages(
        "ton-testnet",
        TX_HASH_HEX,
        depositHints,
      );
      expect(result).toHaveLength(1);
      expect(result[0].result.depositId).toBe(
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      );
    });

    it("falls back to zeroHash when the comment is not a 0x-prefixed 32-byte hex", async () => {
      setupRpcMock([], {
        directTx: buildDepositTx({ body: buildCommentBody("hello") }),
      });
      const result = await new TonVmAttestor().getDepositoryDepositMessages(
        "ton-testnet",
        TX_HASH_HEX,
        depositHints,
      );
      expect(result).toHaveLength(1);
      expect(result[0].result.depositId).toBe(
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      );
    });

    it("accepts an uppercase-hex orderId comment and lowercases it", async () => {
      const upper = DEPOSIT_ORDER_ID.toUpperCase().replace("0X", "0x");
      setupRpcMock([], {
        directTx: buildDepositTx({ body: buildCommentBody(upper) }),
      });
      const result = await new TonVmAttestor().getDepositoryDepositMessages(
        "ton-testnet",
        TX_HASH_HEX,
        depositHints,
      );
      expect(result).toHaveLength(1);
      expect(result[0].result.depositId).toBe(DEPOSIT_ORDER_ID.toLowerCase());
    });

    // Mirrors bitcoin-vm's `|depositor=X|` OP_RETURN metadata — lets the
    // sender credit a third-party hub address (e.g. depositing on behalf of
    // someone else).
    it("uses explicit |depositor=<addr>| from the comment over inbound sender", async () => {
      const explicitDepositor =
        "0:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff";
      const comment = `${DEPOSIT_ORDER_ID}|depositor=${explicitDepositor}|`;
      setupRpcMock([], {
        directTx: buildDepositTx({ body: buildCommentBody(comment) }),
      });
      const result = await new TonVmAttestor().getDepositoryDepositMessages(
        "ton-testnet",
        TX_HASH_HEX,
        depositHints,
      );
      expect(result).toHaveLength(1);
      expect(result[0].result.depositor).toBe(explicitDepositor);
      expect(result[0].result.depositId).toBe(DEPOSIT_ORDER_ID.toLowerCase());
    });

    it("accepts friendly-base64url depositor (EQ…/UQ…) and normalises to raw", async () => {
      // EQ-form of the all-zero address: same hash as `0:0000…0000` but
      // bouncable-friendly base64url encoding.
      const friendlyDepositor = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
      const normalisedRaw = NATIVE_TON_RAW;
      const comment = `${DEPOSIT_ORDER_ID}|depositor=${friendlyDepositor}|`;
      setupRpcMock([], {
        directTx: buildDepositTx({ body: buildCommentBody(comment) }),
      });
      const result = await new TonVmAttestor().getDepositoryDepositMessages(
        "ton-testnet",
        TX_HASH_HEX,
        depositHints,
      );
      expect(result).toHaveLength(1);
      expect(result[0].result.depositor).toBe(normalisedRaw);
    });

    it("normalises a 0Q-form (non-bouncable testnet) depositor to raw", async () => {
      // Real testnet wallet from the e2e fixtures — exercises the actual
      // 0Q friendly form that wallets like Tonkeeper produce.
      const friendlyDepositor = "0QAB_RjVFFvqqOx1UWAveHmkWuz-mM93Y-RDoblG9ZJ3O3LO";
      const normalisedRaw =
        "0:01fd18d5145beaa8ec7551602f7879a45aecfe98cf7763e443a1b946f592773b";
      const comment = `${DEPOSIT_ORDER_ID}|depositor=${friendlyDepositor}|`;
      setupRpcMock([], {
        directTx: buildDepositTx({ body: buildCommentBody(comment) }),
      });
      const result = await new TonVmAttestor().getDepositoryDepositMessages(
        "ton-testnet",
        TX_HASH_HEX,
        depositHints,
      );
      expect(result).toHaveLength(1);
      expect(result[0].result.depositor).toBe(normalisedRaw);
    });

    it("falls back to inbound sender when |depositor=...| is malformed", async () => {
      const comment = `${DEPOSIT_ORDER_ID}|depositor=not-a-ton-address|`;
      setupRpcMock([], {
        directTx: buildDepositTx({ body: buildCommentBody(comment) }),
      });
      const result = await new TonVmAttestor().getDepositoryDepositMessages(
        "ton-testnet",
        TX_HASH_HEX,
        depositHints,
      );
      expect(result).toHaveLength(1);
      expect(result[0].result.depositor).toBe(DEPOSITOR_RAW);
      // Malformed depositor doesn't void the depositId prefix.
      expect(result[0].result.depositId).toBe(DEPOSIT_ORDER_ID.toLowerCase());
    });

    it("falls back to inbound sender when explicit depositor is non-workchain-0", async () => {
      // workchain -1 (masterchain) — v1 scope is wc=0 only.
      const mcDepositor =
        "-1:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff";
      const comment = `${DEPOSIT_ORDER_ID}|depositor=${mcDepositor}|`;
      setupRpcMock([], {
        directTx: buildDepositTx({ body: buildCommentBody(comment) }),
      });
      const result = await new TonVmAttestor().getDepositoryDepositMessages(
        "ton-testnet",
        TX_HASH_HEX,
        depositHints,
      );
      expect(result).toHaveLength(1);
      expect(result[0].result.depositor).toBe(DEPOSITOR_RAW);
    });

    it("requires trailing `|` on the depositor metadata", async () => {
      // No trailing pipe — regex lookahead fails, falls back to sender.
      const explicitDepositor =
        "0:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff";
      const comment = `${DEPOSIT_ORDER_ID}|depositor=${explicitDepositor}`;
      setupRpcMock([], {
        directTx: buildDepositTx({ body: buildCommentBody(comment) }),
      });
      const result = await new TonVmAttestor().getDepositoryDepositMessages(
        "ton-testnet",
        TX_HASH_HEX,
        depositHints,
      );
      expect(result).toHaveLength(1);
      expect(result[0].result.depositor).toBe(DEPOSITOR_RAW);
    });
  });

  describe("unimplemented methods (must surface as externalError / 4xx, not 5xx)", () => {
    it("verifySolverCalls throws as external (4xx, not 5xx)", async () => {
      const err = await new TonVmAttestor()
        .verifySolverCalls("ton-testnet", TX_HASH_HEX, [], "0x")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/does not support solver calls/i);
      expect((err as { isExternalError?: boolean }).isExternalError).toBe(
        true,
      );
    });
  });

  describe("getDepositoryWithdrawalMessage", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    const baseWithdrawal: DecodedTonVmWithdrawal = {
      vmType: "ton-vm",
      withdrawal: {
        receiver: RECIPIENT_RAW,
        amount: "100000000",
        createdAt: 1_700_000_000,
        queryId: 42,
        subwalletId: 0x10ad0001,
        timeout: 3600,
      },
    };

    const setupWithdrawalRpcMock = (options: {
      processedValue?: bigint
      processedExitCode?: number
      processedThrows?: boolean
      processedTupleType?: "int" | "cell" | "slice"
      // get_last_clean_time getter (EXPIRED guard): masterchain time of the
      // wallet's last query-dict rotation, and its exit code.
      lastCleanTime?: number
      lastCleanExitCode?: number
      latestMcSeqno?: number
      // Masterchain block utime — drives the EXPIRED branch.
      latestNow?: number
      // For the EXECUTED path: tx returned by client.getTransaction(addr, lt, hash).
      // Build via buildMockTx() with the right outMessages shape.
      executingTx?: ReturnType<typeof buildMockTx> | null
      // Account state for the processed? error path (uninit → not processed).
      depositoryState?: "active" | "uninitialized" | "frozen"
      // lastTransaction on the account: null = never received anything; non-null
      // on an "uninitialized" state = received deposits (still never deployed —
      // a deposit doesn't deploy the wallet). Either way it's never-executed.
      depositoryLastTransaction?: { lt: string; hash: string } | null
    }) => {
      const latestMcSeqno = options.latestMcSeqno ?? 1000
      const latestNow = options.latestNow ?? 1_700_000_000

      const getMasterchainInfo = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue({
          workchain: -1,
          shard: "-9223372036854775808",
          initSeqno: 0,
          latestSeqno: latestMcSeqno,
        })

      const tupleType = options.processedTupleType ?? "int"
      const stackItem: TupleItem =
        tupleType === "int"
          ? { type: "int", value: options.processedValue ?? 0n }
          : tupleType === "cell"
            ? { type: "cell", cell: beginCell().endCell() }
            : { type: "slice", cell: beginCell().endCell() }
      const lastCleanTime = options.lastCleanTime ?? 0
      const lastCleanExitCode = options.lastCleanExitCode ?? 0
      // Dispatch by method name (processed? vs get_last_clean_time) and build a
      // fresh TupleReader per call so reads don't exhaust a shared reader.
      const runMethodWithError = options.processedThrows
        ? jest
            .fn<() => Promise<unknown>>()
            .mockRejectedValue(new Error("rpc down"))
        : jest
            .fn<(addr: unknown, method: string) => Promise<unknown>>()
            .mockImplementation((_addr, method) => {
              if (method === "get_last_clean_time") {
                return Promise.resolve({
                  gas_used: 0,
                  stack: new TupleReader([
                    { type: "int", value: BigInt(lastCleanTime) },
                  ]),
                  exit_code: lastCleanExitCode,
                })
              }
              return Promise.resolve({
                gas_used: 0,
                stack: new TupleReader([stackItem]),
                exit_code: options.processedExitCode ?? 0,
              })
            })

      const getTransaction = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(options.executingTx ?? null)

      const getContractState = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue({
          state: options.depositoryState ?? "active",
          lastTransaction: options.depositoryLastTransaction ?? null,
        })

      // _ensureTxFinality (EXECUTED path) uses lookupMcBlockSeqnoByUtime to
      // anchor the tx's mc seqno. Mirror setupRpcMock's default: well below
      // latest so finality check passes.
      ;(lookupMcBlockSeqnoByUtime as jest.MockedFunction<
        typeof lookupMcBlockSeqnoByUtime
      >).mockResolvedValue(100)

      // Status branch's "current time" via getBlockHeader(latestSeqno).gen_utime.
      ;(getMcBlockUtime as jest.MockedFunction<
        typeof getMcBlockUtime
      >).mockResolvedValue(latestNow)

      ;(httpRpc as jest.Mock).mockImplementation(() =>
        Promise.resolve({
          client: {
            getTransaction,
            getTransactions: jest.fn(),
            getMasterchainInfo,
            runMethodWithError,
            getContractState,
          },
          chain: { id: "ton-testnet", additionalData: {} },
        }),
      )

      return {
        getMasterchainInfo,
        runMethod: runMethodWithError,
        getTransaction,
        getContractState,
      }
    }

    // Build a Highload V3 external-in command body (highload-v3.ts layout):
    // sig(512) ‖ ^msg_inner{ subwalletId(32) ‖ ^message_to_send ‖ sendMode(8) ‖
    // queryId(23) ‖ createdAt(64) ‖ timeout(22) }.
    const buildHighloadCommandBody = (opts: {
      subwalletId: number;
      queryId: number;
      createdAt: number;
      timeout: number;
      destRaw: string;
      amount: bigint;
    }): Cell => {
      const [wc, hashHex] = opts.destRaw.split(":");
      const dest = new Address(parseInt(wc, 10), Buffer.from(hashHex, "hex"));
      const message = beginCell()
        .store(
          storeMessageRelaxed(
            internal({
              to: dest,
              value: opts.amount,
              bounce: false,
              body: beginCell().endCell(),
            }),
          ),
        )
        .endCell();
      const msgInner = beginCell()
        .storeUint(opts.subwalletId, 32)
        .storeRef(message)
        .storeUint(3, 8)
        .storeUint(opts.queryId, 23)
        .storeUint(opts.createdAt, 64)
        .storeUint(opts.timeout, 22)
        .endCell();
      return beginCell().storeBuffer(Buffer.alloc(64, 7)).storeRef(msgInner).endCell();
    }

    // Build a tx whose external-in command + outbound both match baseWithdrawal.
    // `command` overrides the signed command body (identity-binding tests);
    // `command: null` attaches an internal inMessage (no Highload V3 command).
    // `amount`/`bounce` override only the OUTBOUND message (the defense-in-depth
    // tx.outMessages check, which runs after the command binding).
    // `noOutbound` drops all out messages (accepted-but-skipped send).
    const buildMatchingExecutingTx = (
      overrides: {
        hashHex?: string;
        bounce?: boolean;
        amount?: bigint;
        noOutbound?: boolean;
        command?: {
          subwalletId?: number;
          queryId?: number;
          createdAt?: number;
          timeout?: number;
          destRaw?: string;
          amount?: bigint;
        } | null;
      } = {},
    ) => {
      const w = baseWithdrawal.withdrawal;
      const inMessage =
        overrides.command === null
          ? buildInboundMessage({
              srcRaw: RECIPIENT_RAW,
              destRaw: DEPOSITORY_RAW,
              amount: 0n,
              body: beginCell().endCell(),
            })
          : buildInboundMessage({
              srcRaw: RECIPIENT_RAW,
              destRaw: DEPOSITORY_RAW,
              amount: 0n,
              internal: false,
              body: buildHighloadCommandBody({
                subwalletId: overrides.command?.subwalletId ?? w.subwalletId,
                queryId: overrides.command?.queryId ?? w.queryId,
                createdAt: overrides.command?.createdAt ?? w.createdAt,
                timeout: overrides.command?.timeout ?? w.timeout,
                destRaw: overrides.command?.destRaw ?? RECIPIENT_RAW,
                amount: overrides.command?.amount ?? BigInt(w.amount),
              }),
            })
      return buildMockTx({
        hashHex: overrides.hashHex ?? TX_HASH_HEX,
        now: 1_700_000_000,
        inMessage,
        outMessages: overrides.noOutbound
          ? []
          : [
              buildMockMessage({
                destRaw: RECIPIENT_RAW,
                amount: overrides.amount ?? BigInt(w.amount),
                bounce: overrides.bounce ?? false,
                body: beginCell().endCell(),
              }),
            ],
      })
    }

    const encodedFor = (decoded: DecodedTonVmWithdrawal): string =>
      encodeWithdrawal(decoded)

    it("returns EXECUTED when processed=true + transactionId + outbound matches", async () => {
      const { runMethod, getMasterchainInfo } = setupWithdrawalRpcMock({
        processedValue: -1n,
        executingTx: buildMatchingExecutingTx(),
      });

      const message = await new TonVmAttestor().getDepositoryWithdrawalMessage(
        "ton-testnet",
        encodedFor(baseWithdrawal),
        TX_HASH_HEX,
        { "ton-vm": { lt: "12345" } },
      );

      expect(message.result.status).toBe(DepositoryWithdrawalStatus.EXECUTED);
      expect(message.result.withdrawalId).toBe(
        getDecodedWithdrawalId(baseWithdrawal),
      );
      expect(message.result.depository).toBe(DEPOSITORY_RAW);

      // Finality guard then runMethod at latest (v2 path; the wallet's
      // processed bit is monotonic, so later state is strictly safe).
      expect(getMasterchainInfo).toHaveBeenCalled();
      const [addrArg, methodArg, argsArg] = (runMethod.mock
        .calls[0] as unknown) as [Address, string, unknown[]];
      expect(addrArg.toRawString()).toBe(DEPOSITORY_RAW);
      expect(methodArg).toBe("processed?");
      expect(argsArg).toEqual([
        { type: "int", value: 42n },
        { type: "int", value: 0n },
      ]);
    });

    it("throws when processed=true but transactionId is not provided", async () => {
      setupWithdrawalRpcMock({ processedValue: -1n });
      const err = await new TonVmAttestor()
        .getDepositoryWithdrawalMessage(
          "ton-testnet",
          encodedFor(baseWithdrawal),
        )
        .catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/pass transactionId/i);
      expect((err as { isExternalError?: boolean }).isExternalError).toBe(
        true,
      );
    });

    it("throws when RPC returns a tx with a mismatched hash", async () => {
      setupWithdrawalRpcMock({
        processedValue: -1n,
        executingTx: buildMatchingExecutingTx({ hashHex: OTHER_TX_HASH_HEX }),
      });
      const err = await new TonVmAttestor()
        .getDepositoryWithdrawalMessage(
          "ton-testnet",
          encodedFor(baseWithdrawal),
          TX_HASH_HEX,
          { "ton-vm": { lt: "12345" } },
        )
        .catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/mismatched hash/i);
    });

    it("throws when processed=true but hints.lt is missing", async () => {
      setupWithdrawalRpcMock({ processedValue: -1n });
      const err = await new TonVmAttestor()
        .getDepositoryWithdrawalMessage(
          "ton-testnet",
          encodedFor(baseWithdrawal),
          TX_HASH_HEX,
        )
        .catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/Missing required hint.*ton-vm\.lt/i);
    });

    it("throws when getTransaction returns null for the (lt, hash) cursor", async () => {
      setupWithdrawalRpcMock({ processedValue: -1n, executingTx: null });
      const err = await new TonVmAttestor()
        .getDepositoryWithdrawalMessage(
          "ton-testnet",
          encodedFor(baseWithdrawal),
          TX_HASH_HEX,
          { "ton-vm": { lt: "12345" } },
        )
        .catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/not found.*at lt 12345/i);
    });

    it("throws when executing tx outbound has wrong amount", async () => {
      setupWithdrawalRpcMock({
        processedValue: -1n,
        executingTx: buildMatchingExecutingTx({ amount: 999n }),
      });
      const err = await new TonVmAttestor()
        .getDepositoryWithdrawalMessage(
          "ton-testnet",
          encodedFor(baseWithdrawal),
          TX_HASH_HEX,
          { "ton-vm": { lt: "12345" } },
        )
        .catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/did not match withdrawal/i);
    });

    it("throws when executing tx outbound is bounceable (bounce=true)", async () => {
      setupWithdrawalRpcMock({
        processedValue: -1n,
        executingTx: buildMatchingExecutingTx({ bounce: true }),
      });
      const err = await new TonVmAttestor()
        .getDepositoryWithdrawalMessage(
          "ton-testnet",
          encodedFor(baseWithdrawal),
          TX_HASH_HEX,
          { "ton-vm": { lt: "12345" } },
        )
        .catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/did not match withdrawal/i);
    });

    it("throws when the executing tx command queryId does not match the withdrawal", async () => {
      setupWithdrawalRpcMock({
        processedValue: -1n,
        executingTx: buildMatchingExecutingTx({ command: { queryId: 99 } }),
      });
      const err = await new TonVmAttestor()
        .getDepositoryWithdrawalMessage(
          "ton-testnet",
          encodedFor(baseWithdrawal),
          TX_HASH_HEX,
          { "ton-vm": { lt: "12345" } },
        )
        .catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/command does not match withdrawal/i);
      expect((err as { isExternalError?: boolean }).isExternalError).toBe(true);
    });

    it("throws when the command createdAt differs (defeats a same-queryId collision)", async () => {
      // The colliding tx shares queryId Q but was signed at a different time.
      setupWithdrawalRpcMock({
        processedValue: -1n,
        executingTx: buildMatchingExecutingTx({
          command: { createdAt: baseWithdrawal.withdrawal.createdAt + 1 },
        }),
      });
      const err = await new TonVmAttestor()
        .getDepositoryWithdrawalMessage(
          "ton-testnet",
          encodedFor(baseWithdrawal),
          TX_HASH_HEX,
          { "ton-vm": { lt: "12345" } },
        )
        .catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/command does not match withdrawal/i);
    });

    it("throws when the command pays a different amount than the withdrawal", async () => {
      setupWithdrawalRpcMock({
        processedValue: -1n,
        executingTx: buildMatchingExecutingTx({ command: { amount: 999n } }),
      });
      const err = await new TonVmAttestor()
        .getDepositoryWithdrawalMessage(
          "ton-testnet",
          encodedFor(baseWithdrawal),
          TX_HASH_HEX,
          { "ton-vm": { lt: "12345" } },
        )
        .catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/command does not match withdrawal/i);
    });

    it("throws when the executing tx has no Highload V3 command (internal inMessage)", async () => {
      setupWithdrawalRpcMock({
        processedValue: -1n,
        executingTx: buildMatchingExecutingTx({ command: null }),
      });
      const err = await new TonVmAttestor()
        .getDepositoryWithdrawalMessage(
          "ton-testnet",
          encodedFor(baseWithdrawal),
          TX_HASH_HEX,
          { "ton-vm": { lt: "12345" } },
        )
        .catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/no Highload V3 command/i);
    });

    it("throws when executing tx is reverted", async () => {
      setupWithdrawalRpcMock({
        processedValue: -1n,
        executingTx: buildMockTx({
          hashHex: TX_HASH_HEX,
          now: 1_700_000_000,
          aborted: true,
          computePhase: { type: "vm", success: false, exitCode: 137 },
          outMessages: [
            buildMockMessage({
              destRaw: RECIPIENT_RAW,
              amount: BigInt(baseWithdrawal.withdrawal.amount),
              body: beginCell().endCell(),
            }),
          ],
        }),
      });
      const err = await new TonVmAttestor()
        .getDepositoryWithdrawalMessage(
          "ton-testnet",
          encodedFor(baseWithdrawal),
          TX_HASH_HEX,
          { "ton-vm": { lt: "12345" } },
        )
        .catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/reverted/i);
    });

    it("returns EXPIRED when the consuming tx has zero out messages (send skipped under ignore-errors)", async () => {
      // Command accepted (replay bit committed) but the send was skipped —
      // e.g. insufficient balance. Payout never left and can never re-land.
      setupWithdrawalRpcMock({
        processedValue: -1n,
        executingTx: buildMatchingExecutingTx({ noOutbound: true }),
      });

      const message = await new TonVmAttestor().getDepositoryWithdrawalMessage(
        "ton-testnet",
        encodedFor(baseWithdrawal),
        TX_HASH_HEX,
        { "ton-vm": { lt: "12345" } },
      );

      expect(message.result.status).toBe(DepositoryWithdrawalStatus.EXPIRED);
    });

    it("returns PENDING when processed? is false and within validator-time timeout window", async () => {
      // Validator now < createdAt + 3600 (TON_TIMEOUT) → not expired
      setupWithdrawalRpcMock({
        processedValue: 0n,
        latestNow: 1_700_001_000, // createdAt + 1000s, still within 3600
      });

      const attestor = new TonVmAttestor();
      const message = await attestor.getDepositoryWithdrawalMessage(
        "ton-testnet",
        encodedFor(baseWithdrawal),
      );

      expect(message.result.status).toBe(
        DepositoryWithdrawalStatus.PENDING,
      );
    });

    it("returns EXPIRED when processed? is false and validator now > createdAt + timeout", async () => {
      // Validator now = createdAt + 7200s, past 3600s timeout
      setupWithdrawalRpcMock({
        processedValue: 0n,
        latestNow: 1_700_007_200,
      });

      const attestor = new TonVmAttestor();
      const message = await attestor.getDepositoryWithdrawalMessage(
        "ton-testnet",
        encodedFor(baseWithdrawal),
      );

      expect(message.result.status).toBe(
        DepositoryWithdrawalStatus.EXPIRED,
      );
    });

    it("rejects with a clear error when the depository wallet has no processed? getter", async () => {
      setupWithdrawalRpcMock({ processedExitCode: 11 });

      const attestor = new TonVmAttestor();
      const err = await attestor
        .getDepositoryWithdrawalMessage(
          "ton-testnet",
          encodedFor(baseWithdrawal),
        )
        .catch((e: unknown) => e);

      expect((err as Error).message).toMatch(
        /does not expose the processed\? getter/i,
      );
      expect((err as { isExternalError?: boolean }).isExternalError).toBe(
        true,
      );
    });

    it("rejects when chain is not yet at finality depth (low mc seqno)", async () => {
      setupWithdrawalRpcMock({
        processedValue: -1n,
        latestMcSeqno: 3, // < DEFAULT_MIN_FINALITY_BLOCKS = 5
      });

      const attestor = new TonVmAttestor();
      const err = await attestor
        .getDepositoryWithdrawalMessage(
          "ton-testnet",
          encodedFor(baseWithdrawal),
        )
        .catch((e: unknown) => e);

      expect((err as Error).message).toMatch(/not yet at finality depth/i);
      expect((err as { isExternalError?: boolean }).isExternalError).toBe(
        true,
      );
    });

    it("throws externalError when chain has no depository configured", async () => {
      setupWithdrawalRpcMock({ processedValue: 0n });

      const attestor = new TonVmAttestor();
      const err = await attestor
        .getDepositoryWithdrawalMessage(
          "ton-testnet-no-dep",
          encodedFor(baseWithdrawal),
        )
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/no depository/i);
      expect((err as { isExternalError?: boolean }).isExternalError).toBe(
        true,
      );
    });

    it("rejects when processed? returns an unexpected non-zero exit code", async () => {
      setupWithdrawalRpcMock({ processedValue: 0n, processedExitCode: 9 });

      const attestor = new TonVmAttestor();
      const err = await attestor
        .getDepositoryWithdrawalMessage(
          "ton-testnet",
          encodedFor(baseWithdrawal),
        )
        .catch((e: unknown) => e);

      expect((err as Error).message).toMatch(
        /processed\? returned exit code 9/i,
      );
      expect((err as { isExternalError?: boolean }).isExternalError).toBe(
        true,
      );
    });

    it("returns PENDING when processed? fails because the depository is uninitialized", async () => {
      // First withdrawal: wallet only received deposits, never deployed → the
      // get-method fails (exit -13) but the account is not active, so it can't
      // have processed any queryId.
      setupWithdrawalRpcMock({
        processedExitCode: -13,
        depositoryState: "uninitialized",
        latestNow: 1_700_001_000, // within timeout window
      });

      const message = await new TonVmAttestor().getDepositoryWithdrawalMessage(
        "ton-testnet",
        encodedFor(baseWithdrawal),
      );

      expect(message.result.status).toBe(DepositoryWithdrawalStatus.PENDING);
    });

    it("rejects when processed? returns a non-int tuple", async () => {
      setupWithdrawalRpcMock({ processedTupleType: "cell" });

      const attestor = new TonVmAttestor();
      const err = await attestor
        .getDepositoryWithdrawalMessage(
          "ton-testnet",
          encodedFor(baseWithdrawal),
        )
        .catch((e: unknown) => e);

      expect((err as Error).message).toMatch(/unexpected tuple type/i);
      expect((err as { isExternalError?: boolean }).isExternalError).toBe(
        true,
      );
    });

    it("rejects when latest mc seqno is below the finality buffer", async () => {
      // Finality guard: if latest < MIN_FINALITY_BLOCKS the chain itself
      // isn't deep enough to trust any processed? read.
      setupWithdrawalRpcMock({
        processedValue: -1n,
        latestMcSeqno: 3,
        executingTx: buildMatchingExecutingTx(),
      });

      await expect(
        new TonVmAttestor().getDepositoryWithdrawalMessage(
          "ton-testnet",
          encodedFor(baseWithdrawal),
          TX_HASH_HEX,
          { "ton-vm": { lt: "12345" } },
        ),
      ).rejects.toThrow(/finality depth/i);
    });

    // --- EXPIRED guard against the non-monotonic Highload V3 replay bit ---

    it("returns EXPIRED past the window while the replay record still covers the query (createdAt >= last_clean_time - timeout)", async () => {
      setupWithdrawalRpcMock({
        processedValue: 0n,
        latestNow: 1_700_007_200, // past createdAt + 3600
        lastCleanTime: 1_700_000_000, // == createdAt → guard satisfied
      });

      const message = await new TonVmAttestor().getDepositoryWithdrawalMessage(
        "ton-testnet",
        encodedFor(baseWithdrawal),
      );

      expect(message.result.status).toBe(DepositoryWithdrawalStatus.EXPIRED);
    });

    it("throws indeterminate (NOT EXPIRED) once the replay record ages out (createdAt < last_clean_time - timeout)", async () => {
      setupWithdrawalRpcMock({
        processedValue: 0n,
        latestNow: 1_700_007_200,
        lastCleanTime: 1_700_007_200, // createdAt + 7200; createdAt < that - 3600
      });

      const err = await new TonVmAttestor()
        .getDepositoryWithdrawalMessage(
          "ton-testnet",
          encodedFor(baseWithdrawal),
        )
        .catch((e: unknown) => e);

      expect((err as Error).message).toMatch(/status indeterminate/i);
      expect((err as { isExternalError?: boolean }).isExternalError).toBe(true);
    });

    it("closes the double-spend: an executed-then-GC'd withdrawal (processed?=false after rotation) throws rather than refunding", async () => {
      // Withdrawal executed on-chain (paid out), but Highload V3 forgot the
      // queryId after its dicts rotated, so processed? now reads false. With
      // last_clean_time advanced past the validity window the attestor must NOT
      // return EXPIRED (which would refund an already-paid withdrawal).
      setupWithdrawalRpcMock({
        processedValue: 0n,
        latestNow: 1_700_018_000,
        lastCleanTime: 1_700_014_400, // createdAt + 4*timeout → well aged out
      });

      const err = await new TonVmAttestor()
        .getDepositoryWithdrawalMessage(
          "ton-testnet",
          encodedFor(baseWithdrawal),
          // no transactionId: the cheap EXPIRED path a caller would abuse
        )
        .catch((e: unknown) => e);

      expect((err as Error).message).toMatch(/status indeterminate/i);
      expect((err as { isExternalError?: boolean }).isExternalError).toBe(true);
    });

    // --- aged-out resolution from the supplied consuming tx ---
    // Once the replay record is GC'd, a caller-supplied (transactionId, lt)
    // locator lets the attestor judge from the tx itself: a signed command is
    // accepted at most once ever, so one hash-verified tx is conclusive.

    const agedOutMock = {
      processedValue: 0n,
      latestNow: 1_700_018_000,
      lastCleanTime: 1_700_014_400, // createdAt + 4*timeout → aged out
    };

    it("resolves an aged-out withdrawal to EXECUTED from the supplied consuming tx (outbound matches)", async () => {
      setupWithdrawalRpcMock({
        ...agedOutMock,
        executingTx: buildMatchingExecutingTx(),
      });

      const message = await new TonVmAttestor().getDepositoryWithdrawalMessage(
        "ton-testnet",
        encodedFor(baseWithdrawal),
        TX_HASH_HEX,
        { "ton-vm": { lt: "12345" } },
      );

      expect(message.result.status).toBe(DepositoryWithdrawalStatus.EXECUTED);
    });

    it("resolves an aged-out withdrawal to EXPIRED when the consuming tx skipped the send (zero outbound)", async () => {
      setupWithdrawalRpcMock({
        ...agedOutMock,
        executingTx: buildMatchingExecutingTx({ noOutbound: true }),
      });

      const message = await new TonVmAttestor().getDepositoryWithdrawalMessage(
        "ton-testnet",
        encodedFor(baseWithdrawal),
        TX_HASH_HEX,
        { "ton-vm": { lt: "12345" } },
      );

      expect(message.result.status).toBe(DepositoryWithdrawalStatus.EXPIRED);
    });

    it("aged-out + transactionId without the lt hint → missing-hint error, not indeterminate", async () => {
      setupWithdrawalRpcMock({
        ...agedOutMock,
        executingTx: buildMatchingExecutingTx(),
      });

      const err = await new TonVmAttestor()
        .getDepositoryWithdrawalMessage(
          "ton-testnet",
          encodedFor(baseWithdrawal),
          TX_HASH_HEX,
        )
        .catch((e: unknown) => e);

      expect((err as Error).message).toMatch(/Missing required hint: ton-vm\.lt/i);
      expect((err as { isExternalError?: boolean }).isExternalError).toBe(true);
    });

    it("aged-out + locator that resolves to no tx → error, never EXPIRED", async () => {
      setupWithdrawalRpcMock({ ...agedOutMock, executingTx: null });

      const err = await new TonVmAttestor()
        .getDepositoryWithdrawalMessage(
          "ton-testnet",
          encodedFor(baseWithdrawal),
          TX_HASH_HEX,
          { "ton-vm": { lt: "12345" } },
        )
        .catch((e: unknown) => e);

      expect((err as Error).message).toMatch(/not found/i);
      expect((err as { isExternalError?: boolean }).isExternalError).toBe(true);
    });

    it("aged-out + supplied tx whose command binds a different withdrawal → command-mismatch error", async () => {
      setupWithdrawalRpcMock({
        ...agedOutMock,
        executingTx: buildMatchingExecutingTx({ command: { queryId: 99 } }),
      });

      const err = await new TonVmAttestor()
        .getDepositoryWithdrawalMessage(
          "ton-testnet",
          encodedFor(baseWithdrawal),
          TX_HASH_HEX,
          { "ton-vm": { lt: "12345" } },
        )
        .catch((e: unknown) => e);

      expect((err as Error).message).toMatch(/command does not match withdrawal/i);
      expect((err as { isExternalError?: boolean }).isExternalError).toBe(true);
    });

    it("throws when the consuming tx was addressed to a foreign wallet (never EXPIRED off another account)", async () => {
      // An attacker-controlled Highload V3 wallet could carry a command with
      // identical fields and a skipped send; binding dest to the depository
      // keeps the invariant even if the RPC ignores the address scope.
      const w = baseWithdrawal.withdrawal;
      setupWithdrawalRpcMock({
        ...agedOutMock,
        executingTx: buildMockTx({
          hashHex: TX_HASH_HEX,
          now: 1_700_000_000,
          inMessage: buildInboundMessage({
            srcRaw: RECIPIENT_RAW,
            destRaw: RECIPIENT_RAW, // not the depository
            amount: 0n,
            internal: false,
            body: buildHighloadCommandBody({
              subwalletId: w.subwalletId,
              queryId: w.queryId,
              createdAt: w.createdAt,
              timeout: w.timeout,
              destRaw: RECIPIENT_RAW,
              amount: BigInt(w.amount),
            }),
          }),
          outMessages: [],
        }),
      });

      const err = await new TonVmAttestor()
        .getDepositoryWithdrawalMessage(
          "ton-testnet",
          encodedFor(baseWithdrawal),
          TX_HASH_HEX,
          { "ton-vm": { lt: "12345" } },
        )
        .catch((e: unknown) => e);

      expect((err as Error).message).toMatch(/not addressed to depository/i);
      expect((err as { isExternalError?: boolean }).isExternalError).toBe(true);
    });

    it("aged-out + reverted consuming tx → reverted error (rollback consumed nothing)", async () => {
      setupWithdrawalRpcMock({
        ...agedOutMock,
        executingTx: buildMockTx({
          hashHex: TX_HASH_HEX,
          now: 1_700_000_000,
          aborted: true,
          computePhase: { type: "vm", success: false, exitCode: 137 },
          outMessages: [],
        }),
      });

      const err = await new TonVmAttestor()
        .getDepositoryWithdrawalMessage(
          "ton-testnet",
          encodedFor(baseWithdrawal),
          TX_HASH_HEX,
          { "ton-vm": { lt: "12345" } },
        )
        .catch((e: unknown) => e);

      expect((err as Error).message).toMatch(/reverted/i);
      expect((err as { isExternalError?: boolean }).isExternalError).toBe(true);
    });

    it("fails closed when get_last_clean_time is unavailable (non-zero exit) — never EXPIRED", async () => {
      setupWithdrawalRpcMock({
        processedValue: 0n,
        latestNow: 1_700_007_200,
        lastCleanExitCode: 11,
      });

      const err = await new TonVmAttestor()
        .getDepositoryWithdrawalMessage(
          "ton-testnet",
          encodedFor(baseWithdrawal),
        )
        .catch((e: unknown) => e);

      expect((err as Error).message).toMatch(
        /get_last_clean_time returned exit code 11/i,
      );
      expect((err as { isExternalError?: boolean }).isExternalError).toBe(true);
    });

    it("returns EXPIRED on an uninitialized depository past the window without consulting the replay record", async () => {
      // First withdrawal never broadcast → wallet still uninit → nothing could
      // have executed → processed?=false is unambiguous → EXPIRED (mint-back).
      const { runMethod } = setupWithdrawalRpcMock({
        processedExitCode: -13,
        depositoryState: "uninitialized",
        latestNow: 1_700_007_200, // past timeout
      });

      const message = await new TonVmAttestor().getDepositoryWithdrawalMessage(
        "ton-testnet",
        encodedFor(baseWithdrawal),
      );

      expect(message.result.status).toBe(DepositoryWithdrawalStatus.EXPIRED);
      const calledMethods = runMethod.mock.calls.map(
        (c) => (c as unknown[])[1],
      );
      expect(calledMethods).not.toContain("get_last_clean_time");
    });

    it("returns EXPIRED for an uninitialized depository that only received deposits (lastTransaction present, never deployed)", async () => {
      // The pre-first-withdrawal state: the depository received deposits (so it
      // carries a lastTransaction) but was never deployed, so it executed
      // nothing. "uninitialized" is treated as never-deployed regardless of
      // deposit history → EXPIRED without the get_last_clean_time read.
      const { runMethod } = setupWithdrawalRpcMock({
        processedExitCode: -13,
        depositoryState: "uninitialized",
        depositoryLastTransaction: { lt: "42", hash: "deadbeef" },
        latestNow: 1_700_007_200, // past timeout
      });

      const message = await new TonVmAttestor().getDepositoryWithdrawalMessage(
        "ton-testnet",
        encodedFor(baseWithdrawal),
      );

      expect(message.result.status).toBe(DepositoryWithdrawalStatus.EXPIRED);
      const calledMethods = runMethod.mock.calls.map(
        (c) => (c as unknown[])[1],
      );
      expect(calledMethods).not.toContain("get_last_clean_time");
    });

    it("fails closed (NOT EXPIRED) for a frozen depository past the window — it may have executed then frozen", async () => {
      // A frozen wallet was previously active and may have paid out before
      // freezing, so processed?=false is NOT unambiguous. It must not skip the
      // guard like uninit; the get_last_clean_time read fails on the frozen
      // account → throw rather than refund.
      setupWithdrawalRpcMock({
        processedExitCode: -13,
        depositoryState: "frozen",
        lastCleanExitCode: -13, // get-methods fail on a frozen account
        latestNow: 1_700_007_200, // past timeout
      });

      const err = await new TonVmAttestor()
        .getDepositoryWithdrawalMessage(
          "ton-testnet",
          encodedFor(baseWithdrawal),
        )
        .catch((e: unknown) => e);

      expect((err as Error).message).toMatch(
        /get_last_clean_time returned exit code -13/i,
      );
      expect((err as { isExternalError?: boolean }).isExternalError).toBe(true);
    });
  });
});

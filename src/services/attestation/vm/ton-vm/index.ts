// ABOUTME: TonVmAttestor — verifies ton-vm deposit/fill/refund attestations by parsing
// ABOUTME: TON wallet inbound (deposit) / outbound (fill) messages. Withdrawal stubbed for later phase.
import { Address, Cell, loadMessageRelaxed } from "@ton/core";
import type { TonClient } from "@ton/ton";
import {
  decodeAddress,
  DecodedTonVmWithdrawal,
  decodeWithdrawal,
  DepositoryWithdrawalMessage,
  DepositoryWithdrawalStatus,
  encodeAddress,
  getDecodedWithdrawalId,
  getVmTypeNativeCurrency,
} from "@relay-protocol/settlement-sdk";
import { zeroHash } from "viem";

import { TxHints } from "../..";
import { getDeterministicId } from "../../utils";
import { EnhancedDepositoryDepositMessage, VmAttestor } from "../types";
import { getChain } from "../../../../common/chains";
import { externalError } from "../../../../common/error";
import { getTrackingId, logRpcUsage } from "../../../../common/rpc-usage";
import {
  getMcBlockUtime,
  httpRpc,
  lookupMcBlockSeqnoByUtime,
} from "../../../../common/vm/ton-vm/rpc";

const VM_TYPE = "ton-vm";

// Scan window when looking for a tx by hash on the solver wallet (TON has no
// global tx-hash lookup; list + match client-side).
const SOLVER_TX_SCAN_LIMIT = 50;

// Default ≈ 3 effective post-anchor blocks after subtracting the 1-2 block
// toncenter v2 `lookupBlock(unixtime)` anchor lag.
const DEFAULT_MIN_FINALITY_BLOCKS = 5;

// TON text-comment body prefix: u32(0) + UTF-8 string tail.
const TEXT_COMMENT_OPCODE = 0;

// Relay-canonical orderId form: 0x-prefixed 32-byte hex (matches keccak256 output).
const ORDER_ID_REGEX = /^0x[0-9a-fA-F]{64}$/;
// orderId may sit at the comment head with optional `|key=value|` metadata
// after it (mirrors bitcoin-vm OP_RETURN format).
const ORDER_ID_PREFIX_REGEX = /^0x[0-9a-fA-F]{64}/;
// Explicit depositor metadata: |depositor=<TON-addr>|  (trailing `|` required).
// Same `|key=value|` framing as bitcoin-vm OP_RETURN to keep the conventions
// aligned across VMs.
const DEPOSITOR_REGEX = /\|depositor=([^|]+)(?=\|)/g;

// Highload V3 getter: returns TVM -1 (true) once the queryId is consumed.
const PROCESSED_METHOD = "processed?";

// TVM exit code for "method id not registered" (older wallet variant).
const TVM_METHOD_NOT_FOUND_EXIT_CODE = 11;

// Lazy so the module loads even when the linked SDK doesn't yet ship the
// ton-vm codec; first use surfaces the codec error per-request, not at boot.
let nativeTonEncodedCache: Buffer | undefined;
const getNativeTonEncoded = (): Buffer => {
  if (!nativeTonEncodedCache) {
    nativeTonEncodedCache = Buffer.from(
      encodeAddress(getVmTypeNativeCurrency(VM_TYPE), VM_TYPE),
    );
  }
  return nativeTonEncodedCache;
};

export class TonVmAttestor extends VmAttestor {
  public async getDepositoryDepositMessages(
    chainId: string,
    transactionId: string,
    hints?: TxHints,
  ): Promise<EnhancedDepositoryDepositMessage[]> {
    const trackingId = getTrackingId();

    const tonHints = hints?.[VM_TYPE];
    if (!tonHints?.lt) {
      throw externalError(
        "Missing required hint: ton-vm.lt (TON has no global tx-hash lookup; caller must supply the logical-time cursor for direct lookup)",
      );
    }

    if (!/^[0-9a-fA-F]{64}$/.test(transactionId)) {
      throw externalError(
        `Invalid TON transaction id ${transactionId}: expected 64 hex chars`,
      );
    }

    const chain = await getChain(chainId);
    const depository = chain.depository;
    if (!depository) {
      throw externalError("Chain has no depository configured");
    }

    const depositoryAddr = Address.parse(depository);
    const depositoryHash = Buffer.from(encodeAddress(depository, VM_TYPE));

    const { client } = await httpRpc(chainId);

    await logRpcUsage(chainId, "getTransaction", trackingId);
    const hashBase64 = Buffer.from(
      transactionId.toLowerCase(),
      "hex",
    ).toString("base64");
    const tx = await client.getTransaction(
      depositoryAddr,
      tonHints.lt,
      hashBase64,
    );
    if (!tx) {
      throw externalError(
        `Missing transaction ${transactionId} on depository ${depository} at lt ${tonHints.lt}`,
      );
    }

    // Re-verify the RPC honored the (lt, hash) cursor.
    const returnedHash = tx.hash().toString("hex");
    if (returnedHash !== transactionId.toLowerCase()) {
      throw externalError(
        `RPC returned tx with mismatched hash for ${transactionId} (got ${returnedHash})`,
      );
    }

    if (this._isTransactionReverted(tx)) {
      throw externalError(`Reverted transaction ${transactionId}`);
    }

    await this._ensureTxFinality(
      chainId,
      client,
      tx.now,
      transactionId,
      trackingId,
    );

    const inMsg = tx.inMessage;
    // external-in is the wallet-command flow, not a user deposit.
    if (!inMsg || inMsg.info.type !== "internal") {
      return [];
    }
    // dest is the queried account by construction — defensive guard against
    // RPC returning a tx for a different account.
    if (
      inMsg.info.dest.workChain !== 0 ||
      !inMsg.info.dest.hash.equals(depositoryHash)
    ) {
      return [];
    }
    // bounce=true to uninit → TVM auto-refunds; would double-credit.
    if (inMsg.info.bounce) {
      return [];
    }
    // Only opcode 0 (text comment) is a native-TON deposit; jetton
    // notifications etc. would otherwise be attested as a small native
    // credit from an unspendable jetton-wallet alias.
    const bodySlice = inMsg.body.beginParse();
    if (bodySlice.remainingBits >= 32 && bodySlice.preloadUint(32) !== 0) {
      return [];
    }

    const comment = this._tryDecodeComment(inMsg.body);

    const srcAddr = inMsg.info.src;
    if (srcAddr.workChain !== 0) {
      return [];
    }

    // depositId: whole-comment match for back-compat, else `0x<64hex>` prefix.
    let depositId: string = zeroHash;
    if (comment !== undefined) {
      if (ORDER_ID_REGEX.test(comment)) {
        depositId = comment.toLowerCase();
      } else {
        const prefix = comment.match(ORDER_ID_PREFIX_REGEX);
        if (prefix) {
          depositId = prefix[0].toLowerCase();
        }
      }
    }

    // depositor: explicit `|depositor=<addr>|` in comment if present + valid,
    // else fall back to the inbound message sender. Lets users credit a third
    // party (mirrors bitcoin-vm OP_RETURN metadata).
    const explicitDepositor = this._extractExplicitDepositor(comment);
    const depositor =
      explicitDepositor ?? (decodeAddress(srcAddr.hash, VM_TYPE) as string);

    return [
      {
        data: { chainId, transactionId },
        result: {
          onchainId: getDeterministicId(chainId, transactionId, "0"),
          depository,
          depositId,
          depositor,
          currency: getVmTypeNativeCurrency(VM_TYPE),
          amount: inMsg.info.value.coins.toString(),
        },
        extraData: { timestamp: tx.now.toString() },
      },
    ];
  }

  public async getDepositoryWithdrawalMessage(
    chainId: string,
    withdrawal: string,
    transactionId?: string,
    hints?: TxHints,
  ): Promise<DepositoryWithdrawalMessage> {
    const trackingId = getTrackingId();

    const chain = await getChain(chainId);
    const depository = chain.depository;
    if (!depository) {
      throw externalError("Chain has no depository configured");
    }

    const decodedWithdrawal = decodeWithdrawal(
      withdrawal,
      chain.vmType,
    ) as DecodedTonVmWithdrawal;
    const withdrawalId = getDecodedWithdrawalId(decodedWithdrawal);
    const { receiver, amount, createdAt, queryId, timeout, subwalletId } =
      decodedWithdrawal.withdrawal;

    const depositoryAddr = Address.parse(depository);
    const { client } = await httpRpc(chainId);

    // Liveness signal: read `processed?(queryId, need_clean=0)` on the
    // Highload V3 wallet. The wallet sets the replay-protection bit iff a
    // signed command for this queryId was accepted and executed.
    // Finality guard before the read: require the chain itself at finality
    // depth (latest >= MIN_FINALITY_BLOCKS). runMethod runs at server's latest;
    // the bit is monotonic once set, so reading at any later seqno is safe.
    await logRpcUsage(chainId, "getMasterchainInfo", trackingId);
    const latest = await client.getMasterchainInfo();
    const minBlocks =
      chain.additionalData?.finalizationBlocks ?? DEFAULT_MIN_FINALITY_BLOCKS;
    if (latest.latestSeqno < minBlocks) {
      throw externalError(
        `Chain not yet at finality depth: latest mc seqno ${latest.latestSeqno} < required ${minBlocks}`,
      );
    }

    await logRpcUsage(chainId, "runMethod", trackingId);
    const processedResult = await client.runMethodWithError(
      depositoryAddr,
      PROCESSED_METHOD,
      [
        { type: "int", value: BigInt(queryId) },
        { type: "int", value: 0n },
      ],
    );
    if (processedResult.exit_code === TVM_METHOD_NOT_FOUND_EXIT_CODE) {
      throw externalError(
        `Depository ${depository} does not expose the processed? getter — wallet is not Highload V3`,
      );
    }
    let isProcessed: boolean;
    if (processedResult.exit_code !== 0) {
      // processed? fails on a non-active account (e.g. exit -13). An uninit
      // depository has consumed no queryId, so it's not processed — verify via
      // account state rather than trusting a specific exit code.
      await logRpcUsage(chainId, "getContractState", trackingId);
      const depositoryState = await client.getContractState(depositoryAddr);
      if (depositoryState.state === "active") {
        throw externalError(
          `Highload V3 processed? returned exit code ${processedResult.exit_code} on depository ${depository}`,
        );
      }
      isProcessed = false;
    } else {
      try {
        // TVM boolean on stack: -1 = true, 0 = false. TupleReader throws if the
        // top item isn't an int — surface as an external error.
        isProcessed = processedResult.stack.readBigNumber() === -1n;
      } catch {
        throw externalError(
          `Highload V3 processed? returned unexpected tuple type on depository ${depository}`,
        );
      }
    }

    if (!isProcessed) {
      // Validator-time over wall-clock — matches what the wallet enforces.
      // v2 getMasterchainInfo doesn't carry the latest block's utime; fetch
      // gen_utime via getBlockHeader against the latest mc seqno we observed.
      await logRpcUsage(chainId, "getBlockHeader", trackingId);
      const latestUtime = await getMcBlockUtime(chain, latest.latestSeqno);
      const status: DepositoryWithdrawalStatus =
        latestUtime > createdAt + timeout
          ? DepositoryWithdrawalStatus.EXPIRED
          : DepositoryWithdrawalStatus.PENDING;
      return {
        data: { chainId, withdrawal },
        result: { withdrawalId, depository, status },
      };
    }

    // queryId consumed, but processed? doesn't say WHAT was sent — a buggy
    // MPC could sign different bytes for the same queryId. Require tx id
    // for outbound content verification.
    if (!transactionId) {
      throw externalError(
        `Withdrawal ${withdrawalId} consumed on chain; pass transactionId to verify outbound`,
      );
    }
    const tonHints = hints?.[VM_TYPE];
    if (!tonHints?.lt) {
      throw externalError(
        "Missing required hint: ton-vm.lt (TON has no global tx-hash lookup; depositories fan out fast enough that scan windows are unreliable)",
      );
    }

    await logRpcUsage(chainId, "getTransaction", trackingId);
    const hashBase64 = Buffer.from(
      transactionId.toLowerCase(),
      "hex",
    ).toString("base64");
    const tx = await client.getTransaction(
      depositoryAddr,
      tonHints.lt,
      hashBase64,
    );
    if (!tx) {
      throw externalError(
        `Executing tx ${transactionId} not found on ${depository} at lt ${tonHints.lt}`,
      );
    }
    const returnedHash = tx.hash().toString("hex");
    if (returnedHash !== transactionId.toLowerCase()) {
      throw externalError(
        `RPC returned tx with mismatched hash for ${transactionId} (got ${returnedHash})`,
      );
    }
    if (this._isTransactionReverted(tx)) {
      throw externalError(`Executing tx ${transactionId} reverted`);
    }

    // Bind EXECUTED to THIS withdrawal's signed Highload V3 command. processed?(Q)
    // proves only that *some* command with queryId Q ran; a 23-bit queryId collision
    // (or a buggy MPC signing other bytes for the same id) could otherwise let a
    // different command's tx pass. Parse the tx's external-in command and require
    // its identity + payout to be exactly this withdrawal.
    const inMsg = tx.inMessage;
    if (!inMsg || inMsg.info.type !== "external-in") {
      throw externalError(
        `Executing tx ${transactionId} has no Highload V3 command (external-in) to bind withdrawal ${withdrawalId}`,
      );
    }
    let cmdSubwalletId: bigint;
    let cmdQueryId: bigint;
    let cmdCreatedAt: bigint;
    let cmdTimeout: bigint;
    let cmdSent: ReturnType<typeof loadMessageRelaxed>["info"];
    try {
      // external-in body: signature(512) ‖ ^msg_inner. msg_inner = subwallet_id(32)
      // ‖ ^message_to_send ‖ send_mode(8) ‖ query_id(23) ‖ created_at(64) ‖ timeout(22).
      const inner = inMsg.body.beginParse().loadRef().beginParse();
      cmdSubwalletId = inner.loadUintBig(32);
      const sentRef = inner.loadRef();
      inner.skip(8); // send_mode
      cmdQueryId = inner.loadUintBig(23);
      cmdCreatedAt = inner.loadUintBig(64);
      cmdTimeout = inner.loadUintBig(22);
      cmdSent = loadMessageRelaxed(sentRef.beginParse()).info;
    } catch {
      throw externalError(
        `Failed to parse Highload V3 command of tx ${transactionId} for withdrawal ${withdrawalId}`,
      );
    }

    const expectedReceiverBuf = Buffer.from(encodeAddress(receiver, VM_TYPE));
    const expectedAmount = BigInt(amount);
    // createdAt separates two collided-queryId withdrawals (distinct signing times);
    // the rest pin the wallet config + exact payout to this withdrawal.
    if (
      cmdQueryId !== BigInt(queryId) ||
      cmdCreatedAt !== BigInt(createdAt) ||
      cmdTimeout !== BigInt(timeout) ||
      cmdSubwalletId !== BigInt(subwalletId) ||
      cmdSent.type !== "internal" ||
      cmdSent.bounce ||
      cmdSent.dest.workChain !== 0 ||
      !cmdSent.dest.hash.equals(expectedReceiverBuf) ||
      cmdSent.value.coins !== expectedAmount
    ) {
      throw externalError(
        `Executing tx ${transactionId} command does not match withdrawal ${withdrawalId} (queryId/createdAt/timeout/subwalletId/receiver/amount)`,
      );
    }
    const matched = [...tx.outMessages.values()].some((msg) => {
      if (msg.info.type !== "internal") return false;
      if (msg.info.bounce) return false;
      if (msg.info.bounced) return false;
      if (msg.info.dest.workChain !== 0) return false;
      if (!msg.info.dest.hash.equals(expectedReceiverBuf)) return false;
      if (msg.info.value.coins !== expectedAmount) return false;
      return true;
    });
    if (!matched) {
      throw externalError(
        `Executing tx ${transactionId} outbound did not match withdrawal ${withdrawalId}`,
      );
    }

    await this._ensureTxFinality(
      chainId,
      client,
      tx.now,
      transactionId,
      trackingId,
    );

    return {
      data: { chainId, withdrawal },
      result: {
        withdrawalId,
        depository,
        status: DepositoryWithdrawalStatus.EXECUTED,
      },
    };
  }

  public async getSolverPaidAmount(
    chainId: string,
    transactionId: string,
    payment: {
      currency: string;
      recipient: string;
      orderId: string;
      extraData: string;
      deadline: number;
    },
    hints?: TxHints,
  ): Promise<bigint> {
    const trackingId = getTrackingId();

    const tonHints = hints?.[VM_TYPE];
    if (!tonHints?.solverAddress) {
      throw externalError(
        "Missing required hint: ton-vm.solverAddress (the solver wallet that signed the fill/refund)",
      );
    }

    if (!/^[0-9a-fA-F]{64}$/.test(transactionId)) {
      throw externalError(
        `Invalid TON transaction id ${transactionId}: expected 64 hex chars`,
      );
    }

    const { client } = await httpRpc(chainId);

    const solverAddr = Address.parse(tonHints.solverAddress);

    // Direct lookup when `lt` supplied, else scan-and-match fallback.
    let tx: Awaited<ReturnType<typeof client.getTransactions>>[number] | undefined;
    if (tonHints.lt) {
      await logRpcUsage(chainId, "getTransaction", trackingId);
      const hashBase64 = Buffer.from(
        transactionId.toLowerCase(),
        "hex",
      ).toString("base64");
      try {
        const direct = await client.getTransaction(
          solverAddr,
          tonHints.lt,
          hashBase64,
        );
        if (direct) {
          tx = direct;
        }
      } catch {
        // Direct lookup failed (network / RPC issue) — fall through to scan.
      }
    }
    if (tx) {
      // Re-verify the RPC honored the (lt, hash) cursor.
      const returnedHash = tx.hash().toString("hex");
      if (returnedHash !== transactionId.toLowerCase()) {
        throw externalError(
          `RPC returned tx with mismatched hash for ${transactionId} (got ${returnedHash})`,
        );
      }
    }
    if (!tx) {
      await logRpcUsage(chainId, "getTransactions", trackingId);
      const recentTxs = await client.getTransactions(solverAddr, {
        limit: SOLVER_TX_SCAN_LIMIT,
        archival: true,
      });
      tx = recentTxs.find(
        (t) => t.hash().toString("hex") === transactionId.toLowerCase(),
      );
    }
    if (!tx) {
      throw externalError(
        `Missing transaction ${transactionId} on chain ${chainId} for solver ${tonHints.solverAddress}`,
      );
    }

    if (this._isTransactionReverted(tx)) {
      throw externalError(`Reverted transaction ${transactionId}`);
    }

    await this._ensureTxFinality(chainId, client, tx.now, transactionId, trackingId);

    if (tx.now > payment.deadline) {
      throw externalError(
        `Transaction ${transactionId} executed at ${tx.now} after deadline ${payment.deadline}`,
      );
    }

    // Native TON only for v1; jetton fills land in a future phase.
    if (!this._isNativeCurrency(payment.currency)) {
      throw externalError(
        `Unsupported currency ${payment.currency} for ton-vm fill (native TON only)`,
      );
    }

    const recipientHash = Buffer.from(
      encodeAddress(payment.recipient, VM_TYPE),
    );

    // Sum across every matching outbound msg (wallets may split a fill).
    let totalPaid = 0n;
    // For the bounce-only-mismatch hint in the error message.
    let skippedBounceableMatches = 0;
    for (const msg of tx.outMessages.values()) {
      if (msg.info.type !== "internal") {
        continue;
      }
      // Refund msgs (bounced=true) are not payments.
      if (msg.info.bounced) {
        continue;
      }
      // -1:<same-hash> would otherwise alias a workchain-0 recipient.
      if (msg.info.dest.workChain !== 0) {
        continue;
      }
      if (!msg.info.dest.hash.equals(recipientHash)) {
        continue;
      }
      const comment = this._tryDecodeComment(msg.body);
      if (
        comment === undefined ||
        comment.toLowerCase() !== payment.orderId.toLowerCase()
      ) {
        continue;
      }
      // bounce=true to uninit → auto-refunded; value overstates credit.
      // Checked AFTER match so the error can call out bounce-only misses.
      if (msg.info.bounce) {
        skippedBounceableMatches += 1;
        continue;
      }
      totalPaid += msg.info.value.coins;
    }

    if (totalPaid === 0n) {
      const bounceableHint =
        skippedBounceableMatches > 0
          ? ` (${skippedBounceableMatches} outbound msg(s) matched recipient + orderId but were bounceable — TON fills must be non-bounceable)`
          : "";
      throw externalError(
        `Could not detect payment to ${payment.recipient} referencing order ${payment.orderId} in tx ${transactionId}${bounceableHint}`,
      );
    }

    return totalPaid;
  }

  public async verifySolverCalls(
    _chainId: string,
    _transactionId: string,
    _calls: string[],
    _extraData: string,
  ): Promise<boolean> {
    throw externalError(
      "ton-vm does not support solver calls in v1; remove `calls` from the order or use a different output chain",
    );
  }

  // Returns undefined for non-comment bodies.
  private _tryDecodeComment(body: Cell): string | undefined {
    try {
      const slice = body.beginParse();
      if (slice.remainingBits < 32) {
        return undefined;
      }
      const opcode = slice.loadUint(32);
      if (opcode !== TEXT_COMMENT_OPCODE) {
        return undefined;
      }
      return slice.loadStringTail();
    } catch {
      return undefined;
    }
  }

  // Returns the canonical raw (`0:<hex>`) form of the first valid `|depositor=X|`
  // metadata entry in the comment, or undefined if none parse as a workchain-0
  // TON address. Rejects garbage and non-basechain candidates so the caller can
  // safely fall back to the inbound sender.
  private _extractExplicitDepositor(
    comment: string | undefined,
  ): string | undefined {
    if (comment === undefined) {
      return undefined;
    }
    for (const match of comment.matchAll(DEPOSITOR_REGEX)) {
      const candidate = match[1];
      try {
        const parsed = Address.parse(candidate);
        if (parsed.workChain !== 0) {
          continue;
        }
        return decodeAddress(parsed.hash, VM_TYPE) as string;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private _isNativeCurrency(currency: string): boolean {
    // Native sentinel outside the try so codec-unavailable propagates.
    const native = getNativeTonEncoded();
    let encoded: Buffer;
    try {
      encoded = Buffer.from(encodeAddress(currency, VM_TYPE));
    } catch {
      return false;
    }
    return encoded.equals(native);
  }

  // Require ≥ minBlocks past the tx's mc anchor (toncenter v2 lookupBlock by
  // tx.now). Equivalent to the prior v4 path but uses only the v2 jsonRPC
  // endpoint — paid v2 providers (QuickNode / Chainstack / Ankr) all expose
  // both getMasterchainInfo and lookupBlock.
  private async _ensureTxFinality(
    chainId: string,
    client: TonClient,
    txTime: number,
    transactionId: string,
    trackingId: string,
  ): Promise<void> {
    const chain = await getChain(chainId);
    const minBlocks =
      chain.additionalData?.finalizationBlocks ?? DEFAULT_MIN_FINALITY_BLOCKS;

    await logRpcUsage(chainId, "getMasterchainInfo", trackingId);
    await logRpcUsage(chainId, "lookupBlock", trackingId);
    const [latest, txMcSeqno] = await Promise.all([
      client.getMasterchainInfo(),
      lookupMcBlockSeqnoByUtime(chain, txTime),
    ]);

    const blocksElapsed = latest.latestSeqno - txMcSeqno;
    if (blocksElapsed < minBlocks) {
      throw externalError(
        `Transaction ${transactionId} not yet finalized: ${blocksElapsed} masterchain blocks elapsed since inclusion, need ${minBlocks}`,
      );
    }
  }

  // Check aborted + computePhase + actionPhase (compute alone misses action
  // failures like RESERVE / send_msg).
  private _isTransactionReverted(tx: { description: unknown }): boolean {
    const description = tx.description as {
      type: string;
      aborted?: boolean;
      computePhase?: {
        type: string;
        success?: boolean;
        exitCode?: number;
        reason?: string;
      };
      actionPhase?: {
        success: boolean;
        valid: boolean;
        resultCode: number;
      };
    };

    if (description.type !== "generic") {
      return true;
    }

    const compute = description.computePhase;
    if (!compute) {
      return true;
    }
    let computeOk = false;
    if (compute.type === "vm") {
      computeOk = compute.success !== false && compute.exitCode === 0;
    } else if (compute.type === "skipped") {
      // Skipped + "no-state" (send to uninit dest) still delivers value.
      computeOk = compute.reason === "no-state";
    }
    if (!computeOk) {
      return true;
    }

    // Value-to-uninit txs have aborted=true + compute=skipped/no-state but
    // value IS credited; only treat aborted as revert when compute ran.
    if (description.aborted && compute.type !== "skipped") {
      return true;
    }

    // null and undefined both valid (real mainnet aborted txs carry null).
    const action = description.actionPhase;
    if (action) {
      if (!action.success || action.resultCode !== 0 || !action.valid) {
        return true;
      }
    }

    return false;
  }
}

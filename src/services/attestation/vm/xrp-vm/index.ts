// ABOUTME: XrpVmAttestor — verifies xrp-vm deposit / fill / withdrawal attestations by
// ABOUTME: parsing XRPL Payment txs. Solver-calls (call outputs) stubbed for a later phase.
import {
  DecodedXrpVmWithdrawal,
  decodeWithdrawal,
  decodeXrpDestination,
  DepositoryWithdrawalMessage,
  DepositoryWithdrawalStatus,
  encodeAddress,
  getDecodedWithdrawalId,
  getVmTypeNativeCurrency,
} from "@relay-protocol/settlement-sdk";
import { zeroHash } from "viem";

import { getDeterministicId } from "../../utils";
import { EnhancedDepositoryDepositMessage, VmAttestor } from "../types";
import { getChain } from "../../../../common/chains";
import { externalError } from "../../../../common/error";
import { logger } from "../../../../common/logger";
import { getTrackingId, logRpcUsage } from "../../../../common/rpc-usage";
import {
  httpRpc,
  XrpMemo,
  XrpTransaction,
} from "../../../../common/vm/xrp-vm/rpc";

const VM_TYPE = "xrp-vm";

// XRPL tx ids are 32 bytes as 64 hex chars (canonically uppercase, no 0x).
// Accept either case; reject 0x-prefixed / wrong length so lookups can't alias.
const TX_ID_REGEX = /^[0-9a-fA-F]{64}$/;

// Relay-canonical deposit/order id: 0x-prefixed 32-byte hex (keccak256 output).
const DEPOSIT_ID_REGEX = /^0x[0-9a-fA-F]{64}$/;

// tx.date is Ripple epoch (2000-01-01T00:00:00Z); Unix = date + this offset.
const RIPPLE_EPOCH_OFFSET = 946684800;

export class XrpVmAttestor extends VmAttestor {
  public async getDepositoryDepositMessages(
    chainId: string,
    transactionId: string,
  ): Promise<EnhancedDepositoryDepositMessage[]> {
    const trackingId = getTrackingId();

    if (!TX_ID_REGEX.test(transactionId)) {
      throw externalError(
        `Invalid XRP transaction id ${transactionId}: expected 64 hex chars`,
      );
    }

    const chain = await getChain(chainId);
    const depository = chain.depository;
    if (!depository) {
      throw externalError("Chain has no depository configured");
    }
    this._requireClassicDepository(depository);

    const rpc = await httpRpc(chainId);
    await logRpcUsage(chainId, "tx", trackingId);
    const tx = await rpc.getTransaction(transactionId);
    if (!tx) {
      throw externalError(`Missing transaction ${transactionId}`);
    }

    // Finality is a boolean on XRPL — a validated ledger never reorgs.
    if (tx.validated !== true) {
      throw externalError(`Transaction ${transactionId} is not yet validated`);
    }
    // Only tesSUCCESS moves funds; tec* is included but transfers nothing.
    if (tx.meta.TransactionResult !== "tesSUCCESS") {
      throw externalError(
        `Transaction ${transactionId} did not succeed: ${tx.meta.TransactionResult}`,
      );
    }

    // Non-Payment txs carry no native deposit to attest.
    if (tx.TransactionType !== "Payment") {
      return [];
    }

    // The depository may be configured as a tagless X-address, while the RPC
    // always returns classic addresses — normalize to the 20-byte AccountID so
    // the same account compares equal regardless of representation.
    const depositoryEncoded = this._encodeAccount(depository);
    // Outbound spends from the depository (sweeps / withdrawals) must not be
    // attested as user deposits.
    if (this._encodeAccount(tx.Account).equals(depositoryEncoded)) {
      return [];
    }
    // Only payments addressed to the depository are deposits.
    if (
      !tx.Destination ||
      !this._encodeAccount(tx.Destination).equals(depositoryEncoded)
    ) {
      return [];
    }

    // Read the delivered amount, never `Amount` — partial payments deliver less
    // than `Amount` with tesSUCCESS. A non-string delivered_amount is an issued
    // currency (IOU), which v1 does not attest.
    const delivered = tx.meta.delivered_amount;
    if (typeof delivered !== "string") {
      return [];
    }

    const timestamp = this._txUnixTime(tx);
    if (timestamp === undefined) {
      throw externalError(`Transaction ${transactionId} is missing a date`);
    }

    const depositId = this._extractDepositId(tx.Memos);

    return [
      {
        data: { chainId, transactionId },
        result: {
          onchainId: getDeterministicId(chainId, transactionId, "0"),
          depository,
          depositId,
          depositor: tx.Account,
          currency: getVmTypeNativeCurrency(VM_TYPE),
          amount: delivered,
        },
        extraData: { timestamp: String(timestamp) },
      },
    ];
  }

  public async getDepositoryWithdrawalMessage(
    chainId: string,
    withdrawal: string,
    transactionId?: string,
  ): Promise<DepositoryWithdrawalMessage> {
    const trackingId = getTrackingId();

    const chain = await getChain(chainId);
    const depository = chain.depository;
    if (!depository) {
      throw externalError("Chain has no depository configured");
    }
    this._requireClassicDepository(depository);

    const decoded = decodeWithdrawal(
      withdrawal,
      VM_TYPE,
    ) as DecodedXrpVmWithdrawal;
    const withdrawalId = getDecodedWithdrawalId(decoded);
    const {
      account,
      amount,
      sequence: seqN,
      lastLedgerSequence: lls,
    } = decoded.withdrawal;

    // The withdrawal's source account must be this chain's depository — the
    // whole state machine reads that one account's sequence/ledger.
    const depositoryEncoded = this._encodeAccount(depository);
    if (!this._encodeAccount(account).equals(depositoryEncoded)) {
      throw externalError(
        `Withdrawal ${withdrawalId} account ${account} does not match depository ${depository}`,
      );
    }

    const rpc = await httpRpc(chainId);

    // Atomic S + L snapshot from ONE account_info(validated): S = current
    // sequence, L = the validated ledger it was read against. Reading them
    // separately (or across nodes) opens a false-EXPIRED race.
    await logRpcUsage(chainId, "account_info", trackingId);
    const info = await rpc.getAccountInfo(depository);
    // actNotFound (uninit / AccountDelete'd depository) → non-terminal error, not
    // EXPIRED: an account can execute then be deleted, so re-crediting = double-spend.
    if (!info) {
      throw externalError(`Depository ${depository} account not found`);
    }
    if (info.validated !== true) {
      throw externalError(
        `Depository ${depository} account_info not from a validated ledger`,
      );
    }
    const currentSequence = info.account_data.Sequence;
    const currentLedger = info.ledger_index;

    const message = (
      status: DepositoryWithdrawalStatus,
    ): DepositoryWithdrawalMessage => ({
      data: { chainId, withdrawal },
      result: { withdrawalId, depository, status },
    });

    // Sequence N not yet consumed.
    if (currentSequence <= seqN) {
      // Within the validity window the payload can still be included; past it
      // the sequence can never consume this payload — protocol-irreversible.
      return currentLedger <= lls
        ? message(DepositoryWithdrawalStatus.PENDING)
        : message(DepositoryWithdrawalStatus.EXPIRED);
    }

    // currentSequence > seqN: sequence N is consumed. Require the caller's executing tx id —
    // the verdict comes from fetching it and checking its signing-hash identity == withdrawalId below.
    if (!transactionId) {
      throw externalError(
        `Withdrawal ${withdrawalId}: sequence ${seqN} consumed on ${depository}; pass transactionId to verify the executing tx`,
      );
    }
    if (!TX_ID_REGEX.test(transactionId)) {
      throw externalError(
        `Invalid XRP transaction id ${transactionId}: expected 64 hex chars`,
      );
    }
    await logRpcUsage(chainId, "tx", trackingId);
    const consumingTx = await rpc.getTransaction(transactionId);
    // Must be THE tx that consumed sequence N on the depository. A sequence is
    // consumed exactly once, so a validated tx from the depository at Sequence N
    // uniquely identifies the consumer; anything else is not verifiable here.
    if (
      !consumingTx ||
      consumingTx.validated !== true ||
      consumingTx.Sequence !== seqN ||
      !this._encodeAccount(consumingTx.Account).equals(depositoryEncoded)
    ) {
      throw externalError(
        `Withdrawal ${withdrawalId}: transaction ${transactionId} is not the validated consumer of sequence ${seqN} on ${depository}`,
      );
    }

    // Full signing-hash identity: rebuild the id from the on-chain consumer and
    // require == withdrawalId, else a same-delivery payload with a different fee/flags/LLS borrows this execution.
    let onChainId: string;
    try {
      onChainId = getDecodedWithdrawalId({
        vmType: VM_TYPE,
        withdrawal: {
          account: consumingTx.Account,
          destination: consumingTx.Destination!,
          amount: String(consumingTx.Amount),
          fee: String(consumingTx.Fee),
          sequence: consumingTx.Sequence!,
          lastLedgerSequence: consumingTx.LastLedgerSequence!,
          flags: consumingTx.Flags ?? 0,
          signingPubKey: consumingTx.SigningPubKey!,
          ...(consumingTx.DestinationTag !== undefined
            ? { destinationTag: consumingTx.DestinationTag }
            : {}),
        },
      });
    } catch (err) {
      // Not a reconstructable native-XRP withdrawal → fail closed, never a verdict.
      throw externalError(
        `Withdrawal ${withdrawalId}: consuming tx ${consumingTx.hash} is not a reconstructable native-XRP withdrawal (${(err as Error).message})`,
      );
    }
    const identityMatches = onChainId === withdrawalId;
    const succeeded = consumingTx.meta.TransactionResult === "tesSUCCESS";
    const delivered = consumingTx.meta.delivered_amount;

    if (identityMatches && succeeded) {
      // Exact payload succeeded but delivered != requested is unreachable for the
      // no-partial-payment builder → refuse a verdict on an anomalous delivery.
      if (typeof delivered !== "string" || BigInt(delivered) !== BigInt(amount)) {
        throw externalError(
          `Withdrawal ${withdrawalId}: consuming tx ${consumingTx.hash} succeeded but delivered ${JSON.stringify(delivered)} != ${amount}`,
        );
      }
      return message(DepositoryWithdrawalStatus.EXECUTED);
    }

    // Not executed → EXPIRED (sequence burned, this payload can never execute).
    // Identity mismatch inside the window = two signed payloads for one sequence (MPC anomaly, alert).
    if (
      !identityMatches &&
      typeof consumingTx.ledger_index === "number" &&
      consumingTx.ledger_index <= lls
    ) {
      logger.warn(
        VM_TYPE,
        `xrp-vm-withdrawal-anomaly: withdrawal ${withdrawalId} chainId=${chainId} sequence=${seqN} consumed by a different payload (tx ${consumingTx.hash}) validated in ledger ${consumingTx.ledger_index} <= lastLedgerSequence ${lls} — two signed payloads for one sequence inside the validity window`,
      );
    }
    return message(DepositoryWithdrawalStatus.EXPIRED);
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
  ): Promise<bigint> {
    const trackingId = getTrackingId();

    if (!TX_ID_REGEX.test(transactionId)) {
      throw externalError(
        `Invalid XRP transaction id ${transactionId}: expected 64 hex chars`,
      );
    }

    const rpc = await httpRpc(chainId);
    await logRpcUsage(chainId, "tx", trackingId);
    const tx = await rpc.getTransaction(transactionId);
    if (!tx) {
      throw externalError(`Missing transaction ${transactionId}`);
    }

    if (tx.validated !== true) {
      throw externalError(`Transaction ${transactionId} is not yet validated`);
    }
    if (tx.meta.TransactionResult !== "tesSUCCESS") {
      throw externalError(
        `Transaction ${transactionId} did not succeed: ${tx.meta.TransactionResult}`,
      );
    }
    if (tx.TransactionType !== "Payment") {
      throw externalError(`Transaction ${transactionId} is not a Payment`);
    }

    // recipient comes from the order and may be given as an X-address, so
    // normalize both sides to the 20-byte AccountID before comparing — an
    // X-address and its classic form are the same account.
    let expectedRecipient: Buffer;
    try {
      expectedRecipient = this._encodeAccount(payment.recipient);
    } catch {
      throw externalError(`Invalid recipient address ${payment.recipient}`);
    }
    if (
      !tx.Destination ||
      !this._encodeAccount(tx.Destination).equals(expectedRecipient)
    ) {
      throw externalError(
        `Transaction ${transactionId} was not paid to ${payment.recipient}`,
      );
    }

    // Native XRP only for v1.
    if (!this._isNativeCurrency(payment.currency)) {
      throw externalError(
        `Unsupported currency ${payment.currency} for xrp-vm fill (native XRP only)`,
      );
    }

    // Bind this fill to exactly one order. An XRPL Payment can carry many memos
    // but delivers value only once, so a tx that also references a second order
    // id could let the single delivery be claimed by multiple orders (the fill
    // execution is keyed by (deposits, order), not by fill tx). Require that the
    // only order id referenced is this one.
    const orderIdMemos = new Set(
      this._decodeMemos(tx.Memos)
        .filter((memo) => DEPOSIT_ID_REGEX.test(memo))
        .map((memo) => memo.toLowerCase()),
    );
    if (!orderIdMemos.has(payment.orderId.toLowerCase())) {
      throw externalError(
        `Transaction ${transactionId} does not reference order id ${payment.orderId}`,
      );
    }
    if (orderIdMemos.size > 1) {
      throw externalError(
        `Transaction ${transactionId} references multiple order ids; a fill must reference exactly one`,
      );
    }

    const timestamp = this._txUnixTime(tx);
    if (timestamp === undefined) {
      throw externalError(`Transaction ${transactionId} is missing a date`);
    }
    if (timestamp > payment.deadline) {
      throw externalError(
        `Transaction ${transactionId} executed after deadline`,
      );
    }

    // delivered_amount is authoritative; a non-string value is an issued
    // currency (IOU) delivery, which is not a native XRP fill.
    const delivered = tx.meta.delivered_amount;
    if (typeof delivered !== "string") {
      throw externalError(
        `Transaction ${transactionId} did not deliver native XRP`,
      );
    }

    return BigInt(delivered);
  }

  public async verifySolverCalls(
    _chainId: string,
    _transactionId: string,
    _calls: string[],
    _extraData: string,
  ): Promise<boolean> {
    throw externalError(
      "xrp-vm does not support solver calls in v1; remove `calls` from the order or use a different output chain",
    );
  }

  // Canonical 20-byte AccountID for a classic/X address (via SDK codec) so
  // equivalent representations of the same account compare equal.
  private _encodeAccount(address: string): Buffer {
    return Buffer.from(encodeAddress(address, VM_TYPE));
  }

  // The depository is our own config and is passed to account_info / account_tx,
  // which require a classic r... account. Reject an X-address so the account
  // format is unambiguous everywhere (RPC input + attestation output) instead of
  // silently breaking at RPC. Order-supplied addresses (recipient) are still
  // normalized — those are compared, never sent to the node.
  private _requireClassicDepository(depository: string): void {
    let account: string;
    try {
      account = decodeXrpDestination(depository).account;
    } catch {
      throw externalError(`Invalid XRP depository address ${depository}`);
    }
    // decodeXrpDestination unwraps an X-address to a different classic string;
    // a classic input comes back unchanged.
    if (account !== depository) {
      throw externalError(
        `XRP depository ${depository} must be a classic r... address, not an X-address`,
      );
    }
  }

  // Native XRP is the zero-account sentinel; v1 attests native only. Compare by
  // account so an equivalent-but-differently-encoded currency still resolves.
  private _isNativeCurrency(currency: string): boolean {
    let encoded: Buffer;
    try {
      encoded = this._encodeAccount(currency);
    } catch {
      return false;
    }
    return encoded.equals(this._encodeAccount(getVmTypeNativeCurrency(VM_TYPE)));
  }

  private _txUnixTime(tx: XrpTransaction): number | undefined {
    if (typeof tx.date !== "number") {
      return undefined;
    }
    return tx.date + RIPPLE_EPOCH_OFFSET;
  }

  // Decodes each memo's MemoData (hex → UTF-8). MemoData is optional per entry.
  private _decodeMemos(memos?: XrpMemo[]): string[] {
    if (!memos) {
      return [];
    }
    const decoded: string[] = [];
    for (const entry of memos) {
      const data = entry?.Memo?.MemoData;
      if (!data) {
        continue;
      }
      decoded.push(Buffer.from(data, "hex").toString("utf8"));
    }
    return decoded;
  }

  // First memo whose decoded text is a canonical 0x-prefixed 32-byte id, else
  // the zero hash (deposit with no id — credited to the depositor only).
  private _extractDepositId(memos?: XrpMemo[]): string {
    for (const decoded of this._decodeMemos(memos)) {
      if (DEPOSIT_ID_REGEX.test(decoded)) {
        return decoded.toLowerCase();
      }
    }
    return zeroHash;
  }
}

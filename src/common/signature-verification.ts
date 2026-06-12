import crypto from "crypto";
import stringify from "json-stable-stringify";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { Verifier as Bip322Verifier } from "bip322-js";
import { Address as TonAddress } from "@ton/core";
import { Address, Hex, keccak256, recoverAddress, verifyMessage } from "viem";

import { Chain, getChain } from "./chains";
import { externalError } from "./error";
import { logger } from "./logger";
import { toHexAddress } from "../services/attestation/vm/tron-vm";
import { httpRpc as lighterHttpRpc } from "./vm/lighter-vm/rpc";
import { httpRpc as tonHttpRpc } from "./vm/ton-vm/rpc";

export type OwnerSignatureData = {
  chainId: string;
  currency: string;
  amount: string;
  ownerChainId: string;
  owner: string;
  recipient: string;
  nonce: string;
  additionalData?: Record<string, unknown>;
};

// Verifies that `owner` (on `ownerChainId`) authorized an operation over the
// given params, using that chain's native signing scheme. Used for any
// owner-authorized action on the owner's funds/alias (withdrawals, transfers,
// etc.) — not withdrawals specifically.
export const verifyOwnerSignature = async ({
  data,
  signature,
}: {
  data: OwnerSignatureData;
  signature: string;
}) => {
  const ownerChain = await getChain(data.ownerChainId);

  switch (ownerChain.vmType) {
    case "ethereum-vm":
    case "hyperliquid-vm":
      return verifyEvmPersonalSign(data, signature);

    case "tron-vm":
      return verifyTronMessage(data, signature);

    case "solana-vm":
      return verifySolanaEd25519(data, signature);

    case "bitcoin-vm":
      return verifyBitcoinMessage(data, signature);

    case "lighter-vm":
      return verifyLighterPersonalSign(data, signature);

    case "ton-vm":
      return verifyTonSignData(data, signature, ownerChain);

    default:
      throw externalError(
        "Signature verification not supported for owner chain",
      );
  }
};

// All VMs use the same digest: SHA256(json-stable-stringify(params)).
// Each VM signs this digest using its native signing method.
const computeDigest = (data: OwnerSignatureData): string =>
  crypto
    .createHash("sha256")
    .update(
      stringify({
        chainId: data.chainId,
        currency: data.currency,
        amount: data.amount,
        ownerChainId: data.ownerChainId,
        owner: data.owner,
        recipient: data.recipient,
        nonce: data.nonce,
        additionalData: data.additionalData,
      })!,
    )
    .digest()
    .toString("hex");

// EVM/Hyperliquid: personal_sign over raw SHA256 bytes.
// `address` defaults to `data.owner`; pass an override when owner is not the
// signing EVM address (e.g. lighter-vm, where owner is the L2 account index).
const verifyEvmPersonalSign = async (
  data: OwnerSignatureData,
  signature: string,
  address: string = data.owner,
) => {
  const digest = computeDigest(data);

  const isSignatureValid = await verifyMessage({
    address: address as Address,
    message: {
      raw: `0x${digest}`,
    },
    signature: signature as Hex,
  });
  if (!isSignatureValid) {
    throw externalError("Invalid signature");
  }
};

// Lighter: owner is the L2 account index (e.g. "476952"), but the signature
// is produced by the L1 EVM owner of that account. Resolve index → l1_address
// via Lighter API, then delegate to the EVM personal_sign verifier.
const verifyLighterPersonalSign = async (
  data: OwnerSignatureData,
  signature: string,
) => {
  // Lighter's `GET /api/v1/account` returns `{ code, total, accounts: [...] }`
  // even when looked up by index. The SDK's return type `Promise<Account>` is
  // misleading — the real body is the wrapper, so cast and read `accounts[0]`.
  let l1Address: string | undefined;
  try {
    const { accountApi } = await lighterHttpRpc(data.ownerChainId);
    const response = (await accountApi.getAccount({
      by: "index",
      value: data.owner,
    })) as unknown as { accounts?: Array<{ l1_address?: string }> };
    l1Address = response.accounts?.[0]?.l1_address;
  } catch (error) {
    logger.warn(
      "signature-verification",
      `Lighter account lookup failed for ${data.owner}: ${error}`,
    );
    throw externalError(`Lighter account ${data.owner} not found`);
  }

  if (!l1Address) {
    throw externalError(`Lighter account ${data.owner} has no l1_address`);
  }

  return verifyEvmPersonalSign(data, signature, l1Address);
};

// Tron: signMessageV2 over SHA256 hex string.
// TronWeb's signMessageV2 uses "\x19TRON Signed Message:\n" prefix.
const TRON_MESSAGE_PREFIX = "\x19TRON Signed Message:\n";

const hashTronMessage = (message: string): Hex => {
  const msgBytes = Buffer.from(message, "utf-8");
  const prefix = Buffer.from(
    `${TRON_MESSAGE_PREFIX}${msgBytes.length}`,
    "utf-8",
  );
  return keccak256(Buffer.concat([prefix, msgBytes]));
};

const verifyTronMessage = async (
  data: OwnerSignatureData,
  signature: string,
) => {
  const digest = computeDigest(data);

  try {
    const recoveredAddress = await recoverAddress({
      hash: hashTronMessage(digest),
      signature: signature as Hex,
    });

    const expectedHex = toHexAddress(data.owner).toLowerCase();
    const recoveredHex = recoveredAddress.toLowerCase();

    if (recoveredHex !== expectedHex) {
      throw externalError("Invalid signature");
    }
  } catch (error: any) {
    if (error?.message === "Invalid signature") {
      throw error;
    }
    throw externalError("Invalid signature");
  }
};

// Solana: Ed25519 sign over SHA256 hex string (as UTF-8 bytes).
// Raw 32-byte digest triggers Phantom's anti-transaction-signing check,
// so wallets sign the 64-char hex string instead.
const verifySolanaEd25519 = async (
  data: OwnerSignatureData,
  signature: string,
) => {
  const digestBytes = Buffer.from(computeDigest(data), "utf-8");

  let pubkeyBytes: Uint8Array;
  try {
    pubkeyBytes = bs58.decode(data.owner);
  } catch {
    throw externalError("Invalid Solana owner address");
  }
  if (pubkeyBytes.length !== 32) {
    throw externalError("Invalid Solana owner address");
  }

  const sigHex = signature.startsWith("0x") ? signature.slice(2) : signature;
  const sigBytes = Buffer.from(sigHex, "hex");
  if (sigBytes.length !== 64) {
    throw externalError("Invalid signature length");
  }

  const isValid = ed25519.verify(sigBytes, digestBytes, pubkeyBytes);
  if (!isValid) {
    throw externalError("Invalid signature");
  }
};

// TON: TonConnect signData (type="text"), spec: ton-connect/docs spec/rpc.md.
// sha256(0xffff || "ton-connect/sign-data/" || addr(BE) || domainLen(BE32) || domain ||
//        timestamp(BE64) || "txt" || payloadLen(BE32) || payload)
// Ed25519 pubkey from get_public_key() on-chain getter.
// additionalData["ton-vm"].timestamp = Unix seconds from TonConnect signData response.
// additionalData["ton-vm"].domain = domain from TonConnect signData response.
export const verifyTonSignData = async (
  data: OwnerSignatureData,
  signature: string,
  ownerChain: Chain,
) => {
  const tonData = data.additionalData?.["ton-vm"] as
    | { timestamp?: unknown; domain?: unknown }
    | undefined;

  const timestamp = tonData?.timestamp;
  if (typeof timestamp !== "number") {
    throw externalError("Missing ton-vm timestamp in additionalData");
  }

  const domain = tonData?.domain;
  if (typeof domain !== "string") {
    throw externalError("Missing ton-vm domain in additionalData");
  }

  const signDataDomain = ownerChain.additionalData?.signDataDomain;
  if (!signDataDomain) {
    throw externalError("ton-vm chain missing signDataDomain config");
  }
  if (domain !== signDataDomain && !domain.endsWith("." + signDataDomain)) {
    throw externalError("Invalid signData domain");
  }

  const { client } = await tonHttpRpc(data.ownerChainId);
  const result = await client.runMethodWithError(
    TonAddress.parse(data.owner),
    "get_public_key",
  );
  if (result.exit_code !== 0) {
    throw externalError(
      `get_public_key failed for owner ${data.owner} (exit ${result.exit_code})`,
    );
  }
  const pubkeyBigInt = result.stack.readBigNumber();
  const pubkeyBytes = Buffer.from(
    pubkeyBigInt.toString(16).padStart(64, "0"),
    "hex",
  );

  // ton-vm timestamp is TonKeeper signing metadata, not part of the withdrawal request.
  const { "ton-vm": _tonMeta, ...otherAdditionalData } = (data.additionalData ?? {}) as Record<string, unknown>;
  const digest = computeDigest({
    ...data,
    additionalData: Object.keys(otherAdditionalData).length ? otherAdditionalData : undefined,
  });
  const payloadBytes = Buffer.from(digest, "utf-8");

  const [wcStr, addrHashHex] = data.owner.split(":");
  const wcBuf = Buffer.alloc(4);
  wcBuf.writeInt32BE(parseInt(wcStr));
  const addrHashBuf = Buffer.from(addrHashHex, "hex");

  const domainUtf8 = Buffer.from(domain, "utf-8");
  const domainLenBuf = Buffer.alloc(4);
  domainLenBuf.writeUInt32BE(domainUtf8.length);

  const timestampBuf = Buffer.alloc(8);
  timestampBuf.writeBigInt64BE(BigInt(timestamp));

  const payloadLenBuf = Buffer.alloc(4);
  payloadLenBuf.writeUInt32BE(payloadBytes.length);

  const message = Buffer.concat([
    Buffer.from([0xff, 0xff]),
    Buffer.from("ton-connect/sign-data/"),
    wcBuf,
    addrHashBuf,
    domainLenBuf,
    domainUtf8,
    timestampBuf,
    Buffer.from("txt"),
    payloadLenBuf,
    payloadBytes,
  ]);
  const messageHash = crypto.createHash("sha256").update(message).digest();

  const sigHex = signature.startsWith("0x") ? signature.slice(2) : signature;
  const sigBytes = Buffer.from(sigHex, "hex");
  if (sigBytes.length !== 64) {
    throw externalError("Invalid signature length");
  }

  const isValid = ed25519.verify(sigBytes, messageHash, pubkeyBytes);
  if (!isValid) {
    throw externalError("Invalid signature");
  }
};

// Bitcoin: signMessage over SHA256 hex string.
// Uses bip322-js which handles both BIP-137 (legacy) and BIP-322 (witness-based)
// signatures for all address types: P2PKH, P2SH-P2WPKH, P2WPKH, P2TR.
// This covers wallets returning BIP-137 (Unisat, Xverse) and BIP-322 (OKX, Leather).
const verifyBitcoinMessage = (
  data: OwnerSignatureData,
  signature: string,
) => {
  const digest = computeDigest(data);
  const sigHex = signature.startsWith("0x") ? signature.slice(2) : signature;
  const sigBase64 = Buffer.from(sigHex, "hex").toString("base64");

  let isValid = false;
  try {
    isValid = Bip322Verifier.verifySignature(data.owner, digest, sigBase64);
  } catch (error) {
    logger.warn(
      "signature-verification",
      `Bitcoin signature verification error for ${data.owner}: ${error}`,
    );
  }
  if (!isValid) {
    throw externalError("Invalid signature");
  }
};


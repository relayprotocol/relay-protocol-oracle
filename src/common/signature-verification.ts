import crypto from "crypto";
import stringify from "json-stable-stringify";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { Verifier as Bip322Verifier } from "bip322-js";
import { Address, Hex, keccak256, recoverAddress, verifyMessage } from "viem";

import { getChain } from "./chains";
import { externalError } from "./error";
import { logger } from "./logger";
import { toHexAddress } from "../services/attestation/vm/tron-vm";
import { httpRpc as lighterHttpRpc } from "./vm/lighter-vm/rpc";

export type WithdrawalSignatureData = {
  chainId: string;
  currency: string;
  amount: string;
  ownerChainId: string;
  owner: string;
  recipient: string;
  nonce: string;
  additionalData?: Record<string, unknown>;
};

export const verifyWithdrawalSignature = async ({
  data,
  signature,
}: {
  data: WithdrawalSignatureData;
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
    default:
      throw externalError(
        "Signature verification not supported for owner chain",
      );
  }
};

// All VMs use the same digest: SHA256(json-stable-stringify(params)).
// Each VM signs this digest using its native signing method.
const computeDigest = (data: WithdrawalSignatureData): string =>
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
  data: WithdrawalSignatureData,
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
  data: WithdrawalSignatureData,
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
  data: WithdrawalSignatureData,
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
  data: WithdrawalSignatureData,
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

// Bitcoin: signMessage over SHA256 hex string.
// Uses bip322-js which handles both BIP-137 (legacy) and BIP-322 (witness-based)
// signatures for all address types: P2PKH, P2SH-P2WPKH, P2WPKH, P2TR.
// This covers wallets returning BIP-137 (Unisat, Xverse) and BIP-322 (OKX, Leather).
const verifyBitcoinMessage = (
  data: WithdrawalSignatureData,
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


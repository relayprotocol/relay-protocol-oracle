import crypto from "crypto";
import stringify from "json-stable-stringify";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { schnorr } from "@noble/curves/secp256k1";
import * as bitcoin from "bitcoinjs-lib";
import * as bitcoinMessage from "bitcoinjs-message";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { SuiClient } from "@mysten/sui/client";
import {
  Address,
  Hex,
  keccak256,
  recoverAddress,
  verifyMessage,
} from "viem";

import { getChain } from "./chains";
import { externalError } from "./error";
import { toHexAddress } from "../services/attestation/vm/tron-vm";

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

    case "sui-vm":
      return verifySuiPersonalMessage(data, signature, ownerChain.httpRpcUrl);

    case "ton-vm":
    case "lighter-vm":
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

// EVM/Hyperliquid: personal_sign over raw SHA256 bytes
const verifyEvmPersonalSign = async (
  data: WithdrawalSignatureData,
  signature: string,
) => {
  const digest = computeDigest(data);

  const isSignatureValid = await verifyMessage({
    address: data.owner as Address,
    message: {
      raw: `0x${digest}`,
    },
    signature: signature as Hex,
  });
  if (!isSignatureValid) {
    throw externalError("Invalid signature");
  }
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

const getBitcoinAddressType = (
  address: string,
): "p2pkh" | "p2sh" | "p2wpkh" | "p2tr" => {
  if (address.startsWith("1") || address.startsWith("m") || address.startsWith("n")) {
    return "p2pkh";
  }
  if (address.startsWith("3") || address.startsWith("2")) {
    return "p2sh";
  }
  if (address.startsWith("bc1q") || address.startsWith("tb1q")) {
    return "p2wpkh";
  }
  if (address.startsWith("bc1p") || address.startsWith("tb1p")) {
    return "p2tr";
  }
  throw externalError("Unsupported Bitcoin address type");
};

// Bitcoin: signMessage over SHA256 hex string
const verifyBitcoinMessage = async (
  data: WithdrawalSignatureData,
  signature: string,
) => {
  const digest = computeDigest(data);
  const addressType = getBitcoinAddressType(data.owner);

  if (addressType === "p2tr") {
    return verifyBip322Taproot(digest, data.owner, signature);
  }

  const sigHex = signature.startsWith("0x") ? signature.slice(2) : signature;
  const sigBuffer = Buffer.from(sigHex, "hex");

  try {
    const checkSegwitAlways = addressType === "p2sh" || addressType === "p2wpkh";

    const isValid = bitcoinMessage.verify(
      digest,
      data.owner,
      sigBuffer,
      undefined,
      checkSegwitAlways,
    );

    if (!isValid) {
      throw externalError("Invalid signature");
    }
  } catch (error: any) {
    if (error?.message === "Invalid signature") {
      throw error;
    }
    throw externalError("Invalid signature");
  }
};

// Precomputed constants for BIP-322
const BIP322_TAG = crypto.createHash("sha256").update("BIP0322-signed-message").digest();
const NULL_TXID = Buffer.alloc(32, 0);
const OP_RETURN_SCRIPT = Buffer.from("6a", "hex");

// Bitcoin P2TR: BIP-322 generic message signing with Schnorr (BIP-340).
// Constructs virtual to_spend/to_sign transactions per BIP-322, computes
// BIP-341 sighash, and verifies the Schnorr signature against the x-only
// pubkey embedded in the bech32m address.
const verifyBip322Taproot = (
  message: string,
  address: string,
  signature: string,
) => {
  // 1. Parse BIP-322 simple witness: varint(1) + varint(len) + sig_bytes
  const sigHex = signature.startsWith("0x") ? signature.slice(2) : signature;
  const witBuf = Buffer.from(sigHex, "hex");

  if (witBuf.length < 3 || witBuf[0] !== 0x01) {
    throw externalError("Invalid BIP-322 witness format");
  }
  const itemLen = witBuf[1];
  if (witBuf.length < 2 + itemLen) {
    throw externalError("Invalid BIP-322 witness format");
  }
  const sigItem = witBuf.slice(2, 2 + itemLen);

  // Handle optional sighash type byte (64 = default, 65 = explicit type)
  let hashType = 0x00; // SIGHASH_DEFAULT
  let sig64: Buffer;
  if (sigItem.length === 64) {
    sig64 = sigItem;
  } else if (sigItem.length === 65) {
    sig64 = sigItem.slice(0, 64);
    hashType = sigItem[64];
  } else {
    throw externalError("Invalid Schnorr signature length");
  }

  // 2. Decode P2TR address → scriptPubKey and x-only pubkey
  const network = address.startsWith("tb1")
    ? bitcoin.networks.testnet
    : bitcoin.networks.bitcoin;
  let scriptPubKey: Buffer;
  try {
    scriptPubKey = bitcoin.address.toOutputScript(address, network);
  } catch {
    throw externalError("Invalid Bitcoin address");
  }
  // P2TR scriptPubKey = OP_1 (0x51) + PUSH32 (0x20) + 32-byte x-only pubkey
  const xOnlyPubkey = scriptPubKey.slice(2);
  if (xOnlyPubkey.length !== 32) {
    throw externalError("Invalid P2TR address");
  }

  // 3. BIP-322 tagged message hash: SHA256(tag || tag || message)
  const msgHash = crypto
    .createHash("sha256")
    .update(BIP322_TAG)
    .update(BIP322_TAG)
    .update(Buffer.from(message, "utf-8"))
    .digest();

  // 4. Construct to_spend virtual transaction
  const toSpend = new bitcoin.Transaction();
  toSpend.version = 0;
  toSpend.locktime = 0;
  toSpend.addInput(
    NULL_TXID,
    0xffffffff, // index
    0, // sequence
    bitcoin.script.compile([bitcoin.opcodes.OP_0, msgHash]),
  );
  toSpend.addOutput(scriptPubKey, 0);

  // 5. Construct to_sign virtual transaction
  const toSign = new bitcoin.Transaction();
  toSign.version = 0;
  toSign.locktime = 0;
  toSign.addInput(toSpend.getHash(), 0, 0);
  toSign.addOutput(OP_RETURN_SCRIPT, 0);

  // 6. Compute BIP-341 sighash
  const sighash = toSign.hashForWitnessV1(
    0,
    [scriptPubKey],
    [0],
    hashType,
  );

  // 7. Verify Schnorr signature
  try {
    const isValid = schnorr.verify(sig64, sighash, xOnlyPubkey);
    if (!isValid) {
      throw externalError("Invalid signature");
    }
  } catch (error: any) {
    if (error?.message === "Invalid signature") {
      throw error;
    }
    throw externalError("Invalid signature");
  }
};

// Sui: signPersonalMessage over SHA256 hex string (as UTF-8 bytes).
// Raw bytes show as garbled text in wallet confirmation dialogs.
// SuiClient is needed for ZkLogin signature verification (GraphQL proof check).
const verifySuiPersonalMessage = async (
  data: WithdrawalSignatureData,
  signature: string,
  httpRpcUrl?: string,
) => {
  const messageBytes = Buffer.from(computeDigest(data), "utf-8");

  const sigHex = signature.startsWith("0x") ? signature.slice(2) : signature;
  const sigBase64 = Buffer.from(sigHex, "hex").toString("base64");

  const client = httpRpcUrl
    ? new SuiClient({ url: httpRpcUrl })
    : undefined;

  try {
    const publicKey = await verifyPersonalMessageSignature(
      messageBytes,
      sigBase64,
      { client },
    );

    const recoveredAddress = publicKey.toSuiAddress();
    if (recoveredAddress !== data.owner) {
      throw externalError("Invalid signature");
    }
  } catch (error: any) {
    if (error?.message === "Invalid signature") {
      throw error;
    }
    throw externalError("Invalid signature");
  }
};

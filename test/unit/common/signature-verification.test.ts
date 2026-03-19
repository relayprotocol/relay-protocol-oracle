import { describe, expect, it, jest, beforeAll } from "@jest/globals";
import { privateKeyToAccount } from "viem/accounts";
import { Hex, keccak256 } from "viem";
import crypto from "crypto";
import stringify from "json-stable-stringify";
import { ed25519 } from "@noble/curves/ed25519";
import { schnorr } from "@noble/curves/secp256k1";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { ECPairFactory } from "ecpair";
import * as ecc from "tiny-secp256k1";
import * as bitcoin from "bitcoinjs-lib";
const { payments, Transaction, script, opcodes, networks, initEccLib } = bitcoin;
import * as bitcoinMessage from "bitcoinjs-message";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import * as tronweb from "tronweb";

import { Chain } from "../../../src/common/chains";
import type { WithdrawalSignatureData } from "../../../src/common/signature-verification";

// Mock chains module
const mockChains: Record<string, Chain> = {};

jest.mock("../../../src/common/chains", () => ({
  getChain: async (chainId: string) => {
    const chain = mockChains[chainId];
    if (!chain) {
      const { externalError } = await import("../../../src/common/error");
      throw externalError(`Chain ${chainId} is not available`);
    }
    return chain;
  },
}));

import { verifyWithdrawalSignature } from "../../../src/common/signature-verification";

// Test accounts (EVM)
const testPrivateKey =
  "0x1234567890123456789012345678901234567890123456789012345678901234" as Hex;
const wallet = privateKeyToAccount(testPrivateKey);

const otherPrivateKey =
  "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd" as Hex;
const otherWallet = privateKeyToAccount(otherPrivateKey);

const baseData = {
  chainId: "8453",
  currency: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  amount: "1000000",
  ownerChainId: "1",
  owner: wallet.address,
  recipient: "0x1234567890123456789012345678901234567890",
  nonce: "42",
};

// Helpers

// All VMs sign the same SHA256(json-stable-stringify(params)) digest
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

// Helper: sign EVM (personal_sign over raw SHA256 bytes)
const signEvmMessage = async (
  data: WithdrawalSignatureData,
  account = wallet,
) => {
  const digest = computeDigest(data);
  return account.signMessage({
    message: { raw: `0x${digest}` as Hex },
  });
};

// Helper: Solana (Ed25519 sign over SHA256 hex string as UTF-8 bytes)
const signSolanaMessage = (
  data: WithdrawalSignatureData,
  keypair: Keypair,
) => {
  const digestBytes = Buffer.from(computeDigest(data), "utf-8");
  const sigBytes = ed25519.sign(digestBytes, keypair.secretKey.slice(0, 32));
  return "0x" + Buffer.from(sigBytes).toString("hex");
};

// Helper: Bitcoin (signMessage over SHA256 hex string)
const ECPair = ECPairFactory(ecc);

const signBitcoinMessage = (
  data: WithdrawalSignatureData,
  privateKey: Buffer,
  compressed: boolean,
  segwitType?: "p2wpkh" | "p2sh(p2wpkh)",
) => {
  const digest = computeDigest(data);
  const sig = bitcoinMessage.sign(
    digest,
    privateKey,
    compressed,
    segwitType ? { segwitType } : undefined,
  );
  return "0x" + sig.toString("hex");
};

// Helper: Tron (signMessageV2 over SHA256 hex string, TRON prefix)
const TRON_MESSAGE_PREFIX = "\x19TRON Signed Message:\n";

const signTronMessage = async (
  data: WithdrawalSignatureData,
  account = wallet,
) => {
  const digest = computeDigest(data);
  const msgBytes = Buffer.from(digest, "utf-8");
  const prefix = Buffer.from(
    `${TRON_MESSAGE_PREFIX}${msgBytes.length}`,
    "utf-8",
  );
  const hash = keccak256(Buffer.concat([prefix, msgBytes]));
  return account.sign({ hash: hash as Hex });
};

// Helper: BIP-322 Taproot signing — construct virtual tx, compute sighash, Schnorr sign
initEccLib(ecc);

const signBip322Taproot = (
  data: WithdrawalSignatureData,
  internalPrivateKey: Buffer,
): { signature: string; address: string } => {
  const message = computeDigest(data);

  // Derive internal x-only pubkey
  const fullPubkey = Buffer.from(ecc.pointFromScalar(internalPrivateKey)!);
  const xOnlyPubkey = fullPubkey.slice(1, 33);

  // P2TR with no script tree — tweaks internal key
  const p2tr = payments.p2tr({
    internalPubkey: xOnlyPubkey,
    network: networks.bitcoin,
  });
  const address = p2tr.address!;
  const scriptPubKey = p2tr.output!;

  // Tweak the private key for signing
  // If internal pubkey has odd Y (prefix 0x03), negate private key first
  let privKey = Uint8Array.from(internalPrivateKey);
  if (fullPubkey[0] === 3) {
    const order = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
    const k = BigInt("0x" + Buffer.from(privKey).toString("hex"));
    const negated = (order - k) % order;
    privKey = Buffer.from(negated.toString(16).padStart(64, "0"), "hex");
  }
  const tapTweakTag = crypto.createHash("sha256").update("TapTweak").digest();
  const tweak = crypto.createHash("sha256")
    .update(tapTweakTag).update(tapTweakTag).update(xOnlyPubkey)
    .digest();
  const tweakedPrivKey = Buffer.from(ecc.privateAdd(privKey, tweak)!);

  // BIP-322 message hash
  const tag = crypto.createHash("sha256").update("BIP0322-signed-message").digest();
  const msgHash = crypto.createHash("sha256")
    .update(tag).update(tag).update(Buffer.from(message, "utf-8"))
    .digest();

  // Construct to_spend
  const toSpend = new Transaction();
  toSpend.version = 0;
  toSpend.locktime = 0;
  toSpend.addInput(Buffer.alloc(32, 0), 0xffffffff, 0,
    script.compile([opcodes.OP_0, msgHash]));
  toSpend.addOutput(scriptPubKey, 0);

  // Construct to_sign
  const toSign = new Transaction();
  toSign.version = 0;
  toSign.locktime = 0;
  toSign.addInput(toSpend.getHash(), 0, 0);
  toSign.addOutput(Buffer.from("6a", "hex"), 0);

  // BIP-341 sighash
  const sighash = toSign.hashForWitnessV1(0, [scriptPubKey], [0], 0x00);

  // Schnorr sign with tweaked key
  const sig = schnorr.sign(sighash, tweakedPrivKey);

  // Encode as BIP-322 simple witness: 01 40 <64-byte sig>
  const witness = Buffer.concat([Buffer.from([0x01, 0x40]), Buffer.from(sig)]);

  return { signature: "0x" + witness.toString("hex"), address };
};

// Helper: derive Tron Base58 address from EVM address
const evmToTronAddress = (evmAddress: string): string => {
  return tronweb.utils.address.fromHex("41" + evmAddress.slice(2));
};

beforeAll(() => {
  mockChains["1"] = {
    id: "1",
    vmType: "ethereum-vm",
    httpRpcUrl: "http://localhost:8545",
  };
  mockChains["8453"] = {
    id: "8453",
    vmType: "ethereum-vm",
    httpRpcUrl: "http://localhost:8545",
  };
  mockChains["999"] = {
    id: "999",
    vmType: "hyperliquid-vm",
    httpRpcUrl: "http://localhost:8545",
  };
  mockChains["solana-mainnet"] = {
    id: "solana-mainnet",
    vmType: "solana-vm",
    httpRpcUrl: "http://localhost:8899",
  };
  mockChains["bitcoin-mainnet"] = {
    id: "bitcoin-mainnet",
    vmType: "bitcoin-vm",
    httpRpcUrl: "http://localhost:8332",
  };
  mockChains["sui-mainnet"] = {
    id: "sui-mainnet",
    vmType: "sui-vm",
    httpRpcUrl: "http://localhost:9000",
  };
  mockChains["tron-mainnet"] = {
    id: "tron-mainnet",
    vmType: "tron-vm",
    httpRpcUrl: "http://localhost:8090",
  };
  mockChains["ton-mainnet"] = {
    id: "ton-mainnet",
    vmType: "ton-vm",
    httpRpcUrl: "http://localhost:8080",
  };
  mockChains["lighter-mainnet"] = {
    id: "lighter-mainnet",
    vmType: "lighter-vm",
    httpRpcUrl: "http://localhost:8080",
  };
});

describe("verifyWithdrawalSignature", () => {
  describe("EVM / Hyperliquid", () => {
    it("should pass with valid EVM signature", async () => {
      const signature = await signEvmMessage(baseData);
      await expect(
        verifyWithdrawalSignature({ data: baseData, signature }),
      ).resolves.toBeUndefined();
    });

    it("should pass with valid Hyperliquid signature", async () => {
      const data = { ...baseData, ownerChainId: "999" };
      const signature = await signEvmMessage(data);
      await expect(
        verifyWithdrawalSignature({ data, signature }),
      ).resolves.toBeUndefined();
    });
  });

  describe("unsupported VMs", () => {
    it("should throw unsupported for ton-vm", async () => {
      await expect(
        verifyWithdrawalSignature({
          data: { ...baseData, ownerChainId: "ton-mainnet" },
          signature: "0x" + "00".repeat(65),
        }),
      ).rejects.toThrow("Signature verification not supported for owner chain");
    });

    it("should throw unsupported for lighter-vm", async () => {
      await expect(
        verifyWithdrawalSignature({
          data: { ...baseData, ownerChainId: "lighter-mainnet" },
          signature: "0x" + "00".repeat(65),
        }),
      ).rejects.toThrow("Signature verification not supported for owner chain");
    });
  });

  describe("Tron signMessageV2", () => {
    const tronOwner = evmToTronAddress(wallet.address);

    const tronData = {
      ...baseData,
      ownerChainId: "tron-mainnet",
      owner: tronOwner,
    };

    it("should pass with valid Tron signMessageV2 signature", async () => {
      // signMessageV2 uses EIP-191 personal_sign over human-readable message
      const signature = await signTronMessage(tronData);
      await expect(
        verifyWithdrawalSignature({
          data: tronData,
          signature,
        }),
      ).resolves.toBeUndefined();
    });

    it("should use Tron Base58 address as owner in signed data", () => {
      // The Tron owner in signed data is the Base58Check address, not hex
      expect(tronOwner).toMatch(/^T/);
      expect(tronOwner).not.toMatch(/^0x/);
    });

    it("should throw with wrong Tron signer", async () => {
      const signature = await signTronMessage(tronData, otherWallet);
      await expect(
        verifyWithdrawalSignature({
          data: tronData,
          signature,
        }),
      ).rejects.toThrow("Invalid signature");
    });

    it("should throw with tampered Tron message", async () => {
      const signature = await signTronMessage(tronData);
      await expect(
        verifyWithdrawalSignature({
          data: { ...tronData, amount: "9999" },
          signature,
        }),
      ).rejects.toThrow("Invalid signature");
    });
  });

  describe("Solana Ed25519", () => {
    const solanaKeypair = Keypair.generate();
    const solanaOwner = solanaKeypair.publicKey.toBase58();

    const solanaData = {
      ...baseData,
      ownerChainId: "solana-mainnet",
      owner: solanaOwner,
    };

    it("should pass with valid Solana Ed25519 signature", async () => {
      const signature = signSolanaMessage(solanaData, solanaKeypair);
      await expect(
        verifyWithdrawalSignature({
          data: solanaData,
          signature,
        }),
      ).resolves.toBeUndefined();
    });

    it("should decode pubkey to 32 bytes", () => {
      const decoded = bs58.decode(solanaOwner);
      expect(decoded.length).toBe(32);
    });

    it("should throw with wrong Solana signer", async () => {
      const otherKeypair = Keypair.generate();
      const signature = signSolanaMessage(solanaData, otherKeypair);
      await expect(
        verifyWithdrawalSignature({
          data: solanaData,
          signature,
        }),
      ).rejects.toThrow("Invalid signature");
    });

    it("should throw with tampered Solana message", async () => {
      const signature = signSolanaMessage(solanaData, solanaKeypair);
      await expect(
        verifyWithdrawalSignature({
          data: { ...solanaData, amount: "9999" },
          signature,
        }),
      ).rejects.toThrow("Invalid signature");
    });

    it("should throw with invalid Base58 owner", async () => {
      await expect(
        verifyWithdrawalSignature({
          data: { ...solanaData, owner: "not-valid-base58!!!" },
          signature: "0x" + "ab".repeat(64),
        }),
      ).rejects.toThrow();
    });

    it("should throw with signature too short", async () => {
      await expect(
        verifyWithdrawalSignature({
          data: solanaData,
          signature: "0x" + "ab".repeat(32),
        }),
      ).rejects.toThrow();
    });

    it("should pass with additionalData in message", async () => {
      const data = {
        ...solanaData,
        additionalData: { key: "value" },
      };
      const signature = signSolanaMessage(data, solanaKeypair);
      await expect(
        verifyWithdrawalSignature({
          data,
          signature,
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("Bitcoin BIP-137", () => {
    const btcKeyPair = ECPair.makeRandom({ compressed: true });
    const pubkey = Buffer.from(btcKeyPair.publicKey);
    const p2pkhAddress = payments.p2pkh({ pubkey }).address!;
    const p2wpkhAddress = payments.p2wpkh({ pubkey }).address!;
    const p2shAddress = payments.p2sh({
      redeem: payments.p2wpkh({ pubkey }),
    }).address!;

    it("should pass with P2PKH address", async () => {
      const data = {
        ...baseData,
        ownerChainId: "bitcoin-mainnet",
        owner: p2pkhAddress,
      };
      const signature = signBitcoinMessage(
        data,
        Buffer.from(btcKeyPair.privateKey!),
        btcKeyPair.compressed,
      );
      await expect(
        verifyWithdrawalSignature({
          data,
          signature,
        }),
      ).resolves.toBeUndefined();
    });

    it("should pass with P2SH-P2WPKH address", async () => {
      const data = {
        ...baseData,
        ownerChainId: "bitcoin-mainnet",
        owner: p2shAddress,
      };
      const signature = signBitcoinMessage(
        data,
        Buffer.from(btcKeyPair.privateKey!),
        btcKeyPair.compressed,
        "p2sh(p2wpkh)",
      );
      await expect(
        verifyWithdrawalSignature({
          data,
          signature,
        }),
      ).resolves.toBeUndefined();
    });

    it("should pass with P2WPKH address", async () => {
      const data = {
        ...baseData,
        ownerChainId: "bitcoin-mainnet",
        owner: p2wpkhAddress,
      };
      const signature = signBitcoinMessage(
        data,
        Buffer.from(btcKeyPair.privateKey!),
        btcKeyPair.compressed,
        "p2wpkh",
      );
      await expect(
        verifyWithdrawalSignature({
          data,
          signature,
        }),
      ).resolves.toBeUndefined();
    });

    it("should throw with wrong Bitcoin signer", async () => {
      const otherKp = ECPair.makeRandom({ compressed: true });
      const data = {
        ...baseData,
        ownerChainId: "bitcoin-mainnet",
        owner: p2wpkhAddress,
      };
      const signature = signBitcoinMessage(
        data,
        Buffer.from(otherKp.privateKey!),
        otherKp.compressed,
        "p2wpkh",
      );
      await expect(
        verifyWithdrawalSignature({
          data,
          signature,
        }),
      ).rejects.toThrow("Invalid signature");
    });

    it("should throw with invalid Bitcoin address", async () => {
      await expect(
        verifyWithdrawalSignature({
          data: {
            ...baseData,
            ownerChainId: "bitcoin-mainnet",
            owner: "xyz123invalidaddress",
          },
          signature: "0x" + "ab".repeat(65),
        }),
      ).rejects.toThrow();
    });

    it("should pass with P2TR address (BIP-322 Schnorr)", async () => {
      const taprootKey = ECPair.makeRandom({ compressed: true });
      // First call to derive the Taproot address
      const { address: taprootAddr } = signBip322Taproot(
        { ...baseData, ownerChainId: "bitcoin-mainnet", owner: "placeholder" },
        Buffer.from(taprootKey.privateKey!),
      );
      // Sign with the correct owner in message
      const data = { ...baseData, ownerChainId: "bitcoin-mainnet", owner: taprootAddr };
      const { signature } = signBip322Taproot(data, Buffer.from(taprootKey.privateKey!));
      await expect(
        verifyWithdrawalSignature({ data, signature }),
      ).resolves.toBeUndefined();
    });

    it("should throw with wrong P2TR signer (BIP-322)", async () => {
      const keyA = ECPair.makeRandom({ compressed: true });
      const keyB = ECPair.makeRandom({ compressed: true });
      const { address: addrA } = signBip322Taproot(
        { ...baseData, ownerChainId: "bitcoin-mainnet", owner: "" },
        Buffer.from(keyA.privateKey!),
      );
      const data = { ...baseData, ownerChainId: "bitcoin-mainnet", owner: addrA };
      // Sign with keyB but claim to be addrA
      const { signature } = signBip322Taproot(data, Buffer.from(keyB.privateKey!));
      await expect(
        verifyWithdrawalSignature({ data, signature }),
      ).rejects.toThrow("Invalid signature");
    });

    it("should throw with tampered P2TR message (BIP-322)", async () => {
      const key = ECPair.makeRandom({ compressed: true });
      const { address: addr } = signBip322Taproot(
        { ...baseData, ownerChainId: "bitcoin-mainnet", owner: "" },
        Buffer.from(key.privateKey!),
      );
      const data = { ...baseData, ownerChainId: "bitcoin-mainnet", owner: addr };
      const { signature } = signBip322Taproot(data, Buffer.from(key.privateKey!));
      await expect(
        verifyWithdrawalSignature({ data: { ...data, amount: "9999" }, signature }),
      ).rejects.toThrow("Invalid signature");
    });
  });

  describe("Sui signPersonalMessage", () => {
    it("should pass with valid Sui personal message signature", async () => {
      const suiKeypair = Ed25519Keypair.generate();
      const suiOwner = suiKeypair.toSuiAddress();
      const data = {
        ...baseData,
        ownerChainId: "sui-mainnet",
        owner: suiOwner,
      };

      const digestBytes = Buffer.from(computeDigest(data), "utf-8");
      const { signature: sigBase64 } =
        await suiKeypair.signPersonalMessage(digestBytes);

      // Convert base64 → hex (our wire format)
      const sigHex =
        "0x" + Buffer.from(sigBase64, "base64").toString("hex");

      await expect(
        verifyWithdrawalSignature({
          data,
          signature: sigHex,
        }),
      ).resolves.toBeUndefined();
    });

    it("should throw with wrong Sui signer", async () => {
      const signerKeypair = Ed25519Keypair.generate();
      const otherKeypair = Ed25519Keypair.generate();
      const data = {
        ...baseData,
        ownerChainId: "sui-mainnet",
        owner: otherKeypair.toSuiAddress(), // different address
      };

      const digestBytes = Buffer.from(computeDigest(data), "utf-8");
      const { signature: sigBase64 } =
        await signerKeypair.signPersonalMessage(digestBytes);
      const sigHex =
        "0x" + Buffer.from(sigBase64, "base64").toString("hex");

      await expect(
        verifyWithdrawalSignature({
          data,
          signature: sigHex,
        }),
      ).rejects.toThrow("Invalid signature");
    });
  });

  describe("cross-VM confusion", () => {
    const tronOwner = evmToTronAddress(wallet.address);
    const tronData = { ...baseData, ownerChainId: "tron-mainnet", owner: tronOwner };

    it("should throw when Tron signature is submitted for Solana owner", async () => {
      const crossKeypair = Keypair.generate();
      const solanaOwner = crossKeypair.publicKey.toBase58();

      const tronSig = await signTronMessage(tronData);
      await expect(
        verifyWithdrawalSignature({
          data: { ...tronData, ownerChainId: "solana-mainnet", owner: solanaOwner },
          signature: tronSig,
        }),
      ).rejects.toThrow("Invalid signature");
    });

    it("should throw when Solana signature is submitted for Tron owner", async () => {
      const solanaKeypair = Keypair.generate();
      const solanaData = { ...baseData, ownerChainId: "solana-mainnet", owner: solanaKeypair.publicKey.toBase58() };
      const solanaSig = signSolanaMessage(solanaData, solanaKeypair);

      await expect(
        verifyWithdrawalSignature({
          data: tronData,
          signature: solanaSig,
        }),
      ).rejects.toThrow("Invalid signature");
    });

    it("should throw on cross-chain replay with different chainId", async () => {
      const signature = await signTronMessage(tronData);
      await expect(
        verifyWithdrawalSignature({
          data: { ...tronData, chainId: "999" },
          signature,
        }),
      ).rejects.toThrow("Invalid signature");
    });

    it("should throw on cross-recipient replay", async () => {
      const signature = await signTronMessage(tronData);
      await expect(
        verifyWithdrawalSignature({
          data: {
            ...tronData,
            recipient: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
          },
          signature,
        }),
      ).rejects.toThrow("Invalid signature");
    });

    it("should throw on cross-nonce replay", async () => {
      const signature = await signTronMessage(tronData);
      await expect(
        verifyWithdrawalSignature({
          data: { ...tronData, nonce: "999" },
          signature,
        }),
      ).rejects.toThrow("Invalid signature");
    });

    it("should throw descriptive error for unknown ownerChainId", async () => {
      await expect(
        verifyWithdrawalSignature({
          data: { ...baseData, ownerChainId: "nonexistent-chain" },
          signature: "0x" + "00".repeat(65),
        }),
      ).rejects.toThrow("is not available");
    });

  });

  describe("malformed input", () => {
    const tronOwner = evmToTronAddress(wallet.address);
    const tronData = { ...baseData, ownerChainId: "tron-mainnet", owner: tronOwner };

    it("should throw with signature too long", async () => {
      await expect(
        verifyWithdrawalSignature({
          data: tronData,
          signature: "0x" + "ab".repeat(130),
        }),
      ).rejects.toThrow();
    });

    it("should throw with all-zero signature", async () => {
      await expect(
        verifyWithdrawalSignature({
          data: tronData,
          signature: "0x" + "00".repeat(65),
        }),
      ).rejects.toThrow();
    });

    it("should throw with invalid Tron address owner", async () => {
      await expect(
        verifyWithdrawalSignature({
          data: {
            ...tronData,
            owner: "Tinvalid",
          },
          signature: "0x" + "00".repeat(65),
        }),
      ).rejects.toThrow();
    });
  });

  describe("additionalData edge cases", () => {
    // Use Tron (secp256k1 signMessageV2) for additionalData tests
    const tronOwner = evmToTronAddress(wallet.address);
    const tronBase = { ...baseData, ownerChainId: "tron-mainnet", owner: tronOwner };

    it("should pass with undefined additionalData", async () => {
      const sig = await signTronMessage({ ...tronBase });
      await expect(
        verifyWithdrawalSignature({
          data: { ...tronBase },
          signature: sig,

        }),
      ).resolves.toBeUndefined();
    });

    it("should pass with empty object additionalData", async () => {
      const data = { ...tronBase, additionalData: {} };
      const signature = await signTronMessage(data);
      await expect(
        verifyWithdrawalSignature({
          data,
          signature,
        }),
      ).resolves.toBeUndefined();
    });

    it("should pass with deeply nested additionalData", async () => {
      const data = {
        ...tronBase,
        additionalData: { a: { b: { c: 1 } } },
      };
      const signature = await signTronMessage(data);
      await expect(
        verifyWithdrawalSignature({
          data,
          signature,
        }),
      ).resolves.toBeUndefined();
    });

    it("should pass with array values in additionalData", async () => {
      const data = {
        ...tronBase,
        additionalData: { utxos: [{ txid: "abc", vout: 0 }] },
      };
      const signature = await signTronMessage(data);
      await expect(
        verifyWithdrawalSignature({
          data,
          signature,
        }),
      ).resolves.toBeUndefined();
    });

    it("should pass with large additionalData payload", async () => {
      const largeData: Record<string, string> = {};
      for (let i = 0; i < 200; i++) {
        largeData[`key_${i}`] = "x".repeat(50);
      }
      const data = { ...tronBase, additionalData: largeData };
      const signature = await signTronMessage(data);
      await expect(
        verifyWithdrawalSignature({
          data,
          signature,
        }),
      ).resolves.toBeUndefined();
    });

    it("should be invariant to key order via json-stable-stringify", async () => {
      const dataA = { ...tronBase, additionalData: { z: 1, a: 2 } };
      const signature = await signTronMessage(dataA);
      const dataB = { ...tronBase, additionalData: { a: 2, z: 1 } };
      await expect(
        verifyWithdrawalSignature({
          data: dataB,
          signature,
        }),
      ).resolves.toBeUndefined();
    });
  });
});

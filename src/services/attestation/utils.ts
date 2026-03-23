import { JsonRpcProvider } from "@near-js/providers";
import * as bitcoin from "bitcoinjs-lib";
import bs58 from "bs58";
import crypto from "crypto";
import { fromHex, Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";

import { getChains, getHubInfo } from "../../common/chains";

export const getDeterministicId = (...values: string[]) =>
  "0x" +
  crypto
    .createHash("sha256")
    .update(values.join(":").toLowerCase())
    .digest("hex");

export const extractEcdsaSignature = (rawNearSignature: string): string => {
  const parsedSignature = JSON.parse(
    fromHex(rawNearSignature as Hex, "string"),
  );

  const {
    big_r: { affine_point },
    s: { scalar },
    recovery_id,
  } = parsedSignature;

  const r = affine_point.substring(2);
  const s = scalar;
  const v = recovery_id + 27;

  return `0x${r}${s}${v.toString(16).padStart(2, "0")}`.toLowerCase();
};

let _getSignerCache = new Map<string, string>();
let _getBitcoinSignerPubkeyCache = new Map<string, Buffer>();
export const getSigner = async (chainId: string) => {
  if (_getSignerCache.has(chainId)) {
    return _getSignerCache.get(chainId)!;
  }

  const vmType = await getChains().then((chains) => chains[chainId].vmType);

  let domainId: number | undefined;
  switch (vmType) {
    case "bitcoin-vm":
    case "ethereum-vm":
    case "hyperliquid-vm":
    case "tron-vm": {
      domainId = 0;
      break;
    }

    case "solana-vm": {
      domainId = 1;
      break;
    }

    default: {
      throw new Error("Vm type not implemented");
    }
  }

  const hubInfo = await getHubInfo();
  if (!hubInfo.auroraAllocatorAddress) {
    throw new Error("Missing Aurora allocator config");
  }

  const args = {
    domain_id: domainId,
    path: hubInfo.auroraAllocatorAddress.toLowerCase(),
    predecessor: `${hubInfo.auroraAllocatorAddress.slice(2).toLowerCase()}.aurora`,
  };

  const nearRpc = new JsonRpcProvider({
    url: "https://free.rpc.fastnear.com",
  });
  const result = await nearRpc.callFunction(
    "v1.signer",
    "derived_public_key",
    args,
  );

  const [, publicKey] = result!.toString().split(":");
  switch (vmType) {
    case "bitcoin-vm": {
      const raw = Buffer.from(bs58.decode(publicKey));

      const x = raw.subarray(0, 32);
      const y = raw.subarray(32, 64);
      const yIsEven = (y[31] & 1) === 0;
      const prefix = yIsEven ? 0x02 : 0x03;
      const pubKeyCompressed = Buffer.concat([
        Buffer.from([prefix]),
        Buffer.from(x),
      ]);
      _getBitcoinSignerPubkeyCache.set(chainId, pubKeyCompressed);

      _getSignerCache.set(
        chainId,
        bitcoin.payments.p2pkh({
          network: bitcoin.networks.bitcoin,
          pubkey: pubKeyCompressed,
        }).address!,
      );

      break;
    }

    case "ethereum-vm":
    case "hyperliquid-vm":
    case "tron-vm": {
      _getSignerCache.set(
        chainId,
        publicKeyToAddress(
          `0x04${Buffer.from(bs58.decode(publicKey)).toString("hex")}`,
        ).toLowerCase(),
      );

      break;
    }

    case "solana-vm": {
      _getSignerCache.set(chainId, publicKey);

      break;
    }

    default: {
      throw new Error("Vm type not implemented");
    }
  }

  return _getSignerCache.get(chainId)!;
};

export const getBitcoinSignerPubkey = async (chainId: string) => {
  if (!_getBitcoinSignerPubkeyCache.has(chainId)) {
    await getSigner(chainId);
  }

  if (!_getBitcoinSignerPubkeyCache.has(chainId)) {
    throw new Error("Bitcoin signer pubkey not found");
  }

  return Buffer.from(_getBitcoinSignerPubkeyCache.get(chainId)!);
};

const stripHexPrefix = (value: string) =>
  value.startsWith("0x") ? value.slice(2) : value;

export const normalizeBitcoinPartialSignature = (
  signatureHex: string,
  sighashType: number,
): Buffer => {
  const signature = Buffer.from(stripHexPrefix(signatureHex), "hex");

  try {
    bitcoin.script.signature.decode(signature);
    return signature;
  } catch {
    // Continue to compact signature handling
  }

  if (signature.length === 64) {
    return Buffer.from(bitcoin.script.signature.encode(signature, sighashType));
  }

  if (signature.length === 65) {
    const hasRecoveryId = (value: number) => [0, 1, 27, 28].includes(value);
    const compactSignature =
      hasRecoveryId(signature[0]) && !hasRecoveryId(signature[64])
        ? signature.subarray(1, 65)
        : signature.subarray(0, 64);

    return Buffer.from(
      bitcoin.script.signature.encode(compactSignature, sighashType),
    );
  }

  throw new Error(
    `Invalid bitcoin signature format: expected DER+sighash, 64-byte compact, or 65-byte compact+recoveryId, got ${signature.length} bytes`,
  );
};

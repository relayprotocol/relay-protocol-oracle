import { JsonRpcProvider } from "@near-js/providers";
import * as bitcoin from "bitcoinjs-lib";
import bs58 from "bs58";
import crypto from "crypto";
import { Address, fromHex, getContract, Hex, parseAbi } from "viem";
import { publicKeyToAddress } from "viem/accounts";

import { Chain, getChains, getHubInfo } from "../../common/chains";
import { internalError } from "../../common/error";
import { getHubHttpRpc } from "../../common/hub";

export const getDeterministicId = (...values: string[]) =>
  "0x" +
  crypto
    .createHash("sha256")
    .update(values.join(":").toLowerCase())
    .digest("hex");

// Cartesian product of per-slot options. `[[a], [b1, b2]]` becomes `[[a, b1], [a, b2]]`
export const cartesianProduct = <T>(lists: T[][]): T[][] =>
  lists.reduce<T[][]>(
    (acc, list) => acc.flatMap((combo) => list.map((item) => [...combo, item])),
    [[]],
  );

// Select the matching finalization threshold based on the oracle's configuration
export const selectFinalizationThreshold = (
  chain: Chain,
  currency: string,
  amount: bigint,
): {
  finalizationBlocks?: number;
  finalizationTime?: number;
  feeBps?: string;
} | null => {
  if (!chain.additionalData?.fastMode) {
    return null;
  }

  const table = chain.additionalData.fastMode.finalityTiers ?? {};
  const tiers = table[currency] ?? [];

  // Choose the most restrictive tier which matches the amount
  const matchedTier = [...tiers]
    .sort((a, b) => {
      const aMaxAmount = BigInt(a.maxAmount);
      const bMaxAmount = BigInt(b.maxAmount);
      return aMaxAmount < bMaxAmount ? -1 : aMaxAmount > bMaxAmount ? 1 : 0;
    })
    .find((tier) => amount < BigInt(tier.maxAmount));
  if (!matchedTier) {
    return null;
  }

  return {
    finalizationBlocks: matchedTier.finalizationBlocks,
    finalizationTime: matchedTier.finalizationTime,
    feeBps: matchedTier.feeBps,
  };
};

export const isNumericFinalityMet = (
  measured: { confirmations: number; elapsedSeconds: number },
  threshold: { finalizationBlocks?: number; finalizationTime?: number },
): boolean =>
  measured.confirmations >= (threshold.finalizationBlocks ?? 0) &&
  measured.elapsedSeconds >= (threshold.finalizationTime ?? 0);

// Select the strictest finalization threshold for a list of deposits within a single transaction
export const resolveAmountTieredFinality = (
  chain: Chain,
  deposits: { result: { currency: string; amount: string } }[],
  defaults: { finalizationBlocks: number; finalizationTime: number },
): {
  required: { finalizationBlocks: number; finalizationTime: number };
  usedDefaults: boolean;
  tiers: ReturnType<typeof selectFinalizationThreshold>[];
} => {
  const tiers = deposits.map((d) =>
    selectFinalizationThreshold(
      chain,
      d.result.currency,
      BigInt(d.result.amount),
    ),
  );

  let finalizationBlocks = 0;
  let finalizationTime = 0;
  for (const tier of tiers) {
    finalizationBlocks = Math.max(
      finalizationBlocks,
      tier?.finalizationBlocks ?? defaults.finalizationBlocks,
    );
    finalizationTime = Math.max(
      finalizationTime,
      tier?.finalizationTime ?? defaults.finalizationTime,
    );
  }

  return {
    required: {
      finalizationBlocks,
      finalizationTime,
    },
    usedDefaults:
      finalizationBlocks >= defaults.finalizationBlocks &&
      finalizationTime >= defaults.finalizationTime,
    tiers,
  };
};

// Build the rate-limiter's opaque `limiterData` and pre-check its budget off-chain (by limiter type)
export const resolveRateLimiter = async (params: {
  type: string;
  address: string;
  chainId: string;
  currency: string;
  amount: string;
}): Promise<{ rateLimiterData: string; withinBudget: boolean }> => {
  const { type, address, chainId, currency, amount } = params;
  switch (type) {
    case "amount": {
      let withinBudget = true;
      try {
        const limiter = getContract({
          address: address as Address,
          abi: parseAbi([
            "function canConsume(string chainId, bytes currency, uint256 amount) view returns (bool)",
          ]),
          client: await getHubHttpRpc(),
        });

        withinBudget = await limiter.read.canConsume([
          chainId,
          currency as Hex,
          BigInt(amount),
        ]);
      } catch {
        // Skip errors
      }

      // TODO: Integrate rate-limiter
      const rateLimiterData = "0x";

      return { rateLimiterData, withinBudget };
    }

    default: {
      throw internalError(`Unsupported rate limiter type "${type}"`);
    }
  }
};

export const resolveFeeCalculator = async (params: {
  type: string;
  address: string;
  chainId: string;
  currency: string;
  amount: string;
}): Promise<{ feeCalculatorData: string }> => {
  const { type } = params;
  switch (type) {
    case "bps": {
      // TODO: Integrate fee-calculator
      const feeCalculatorData = "0x";

      return { feeCalculatorData };
    }

    default: {
      throw internalError(`Unsupported fee calculator type "${type}"`);
    }
  }
};

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

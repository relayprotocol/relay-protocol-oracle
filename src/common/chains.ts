import { VmType } from "@relay-protocol/settlement-sdk";

import { externalError } from "./error";
import { logger } from "./logger";
import {
  getSettlementChainDefaultsForChain,
  SettlementChainDefaults,
} from "./settlement-networks";
import { readConfigValue } from "./utils";
import { config } from "../config";

export type Chain = {
  // The user-friendly id of the chain
  id: string;
  vmType: VmType;
  httpRpcUrl: string;
  depository?: string;
  // The numeric id of the chain on the Hub - for "ethereum-vm" chains this is the EVM chain id,
  // and for all other chains it is the `keccak256` value of the above user-friendly id
  hubChainId?: string;
  additionalData?: {
    // For "bitcoin-vm"
    esploraCompatibleApiUrl?: string;
    blockstreamClientSecret?: string;
    blockstreamClientId?: string;
    maestroApiKey?: string;
    // For "hyperliquid-vm"
    proxyApiUrl?: string;
    proxyApiKey?: string;
    hubApiUrl?: string;
    hubApiKey?: string;
    // For "ethereum-vm"
    isZksyncStack?: boolean;
    // For "lighter-vm"
    rpcApiKey?: string;
    // For "hub-vm"
    hubAddress?: string;
    oracleAddress?: string;
    oracleMultisigAddress?: string;
    genericMappingAddress?: string;
    auroraChainId?: number;
    auroraAllocatorAddress?: string;
    auroraAllocatorSpenderAddress?: string;
    auroraOracleMultisigAddress?: string;
  };
};

export const HUB_VM_TYPE = "hub-vm" as any as VmType;
export const HUB_CHAIN_ID = 0n;

const DEPOSITORY_REQUIRED_VM_TYPES = new Set<VmType>([
  "ethereum-vm",
  "solana-vm",
  "sui-vm",
  "bitcoin-vm",
  "tron-vm",
  "hyperliquid-vm",
] as VmType[]);

const readAdditionalData = (rawChain: Record<string, any>) => {
  const additionalData: Record<string, any> = {};
  if (!rawChain.additionalData) {
    return additionalData;
  }

  for (const [key, value] of Object.entries(
    (rawChain.additionalData ?? {}) as Record<string, any>,
  )) {
    additionalData[key] = readConfigValue(value);
  }

  return additionalData;
};

const resolveHttpRpcUrl = (
  rawChain: Record<string, any>,
  settlementDefaults: SettlementChainDefaults | undefined,
) => {
  const settlementRpcFallback = settlementDefaults?.httpRpcUrl;
  const localRpcRawValue = rawChain.httpRpcUrl;
  const localRpcValue = readConfigValue(rawChain.httpRpcUrl);

  // Keep literal local values authoritative.
  // Only use settlement fallback when the local value is an unresolved env placeholder.
  if (
    typeof localRpcRawValue === "string" &&
    localRpcRawValue.startsWith("$")
  ) {
    return localRpcValue ?? settlementRpcFallback;
  }

  return localRpcValue ?? settlementRpcFallback;
};

const warnInvalidChainConfiguration = (chain: Chain) => {
  const chainName = chain.id ?? "<missing-id>";

  if (!chain.id) {
    logger.warn("chains", "Configured chain is missing id");
  }
  if (!chain.vmType) {
    logger.warn("chains", `Chain ${chainName} is missing vmType`);
  }
  if (!chain.httpRpcUrl) {
    logger.warn("chains", `Chain ${chainName} is missing httpRpcUrl`);
  }
  if (
    chain.vmType &&
    DEPOSITORY_REQUIRED_VM_TYPES.has(chain.vmType) &&
    !chain.depository
  ) {
    logger.warn(
      "chains",
      `Chain ${chainName} (${chain.vmType}) is missing depository`,
    );
  }
};

let _chains: { [id: string]: Chain } | undefined;
export const getChains = async () => {
  if (!_chains) {
    const __chains: { [id: string]: Chain } = {};

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const chains = require(
      `../../configs/chains.${config.environment}.json`,
    ) as Record<string, any>[];
    for (const chain of chains) {
      const chainId = readConfigValue(chain.id);
      const localHubChainId = readConfigValue(chain.hubChainId);
      const settlementDefaults = chainId
        ? getSettlementChainDefaultsForChain(
            chainId as string,
            localHubChainId as string | undefined,
          )
        : undefined;
      const additionalData = readAdditionalData(chain);

      const resolvedChain: Chain = {
        id: (chainId ?? settlementDefaults?.id) as string,
        vmType: (readConfigValue(chain.vmType) ??
          settlementDefaults?.vmType) as VmType,
        httpRpcUrl: resolveHttpRpcUrl(chain, settlementDefaults) as string,
        depository: (readConfigValue(chain.depository) ??
          settlementDefaults?.depository) as string | undefined,
        hubChainId: (localHubChainId ?? settlementDefaults?.hubChainId) as
          | string
          | undefined,
        additionalData,
      };

      warnInvalidChainConfiguration(resolvedChain);
      if (!resolvedChain.id) {
        continue;
      }
      __chains[resolvedChain.id] = resolvedChain;
    }

    _chains = __chains;
  }

  return _chains;
};

export const getChain = async (chainId: string) => {
  const chains = await getChains();
  if (!chains[chainId]) {
    throw externalError(`Chain ${chainId} is not available`);
  }

  return chains[chainId];
};

export const getChainVmType = async (chainId: string) =>
  getChain(chainId).then((c) => c.vmType);

export const getSdkChainsConfig = async () => {
  return Object.fromEntries(
    Object.values(await getChains()).map((c) => [c.id, c.vmType]),
  );
};

// Helpers for hub chains

export const getHubChains = async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const chains = require(`../../configs/chains.hub.${config.environment}.json`);
  const __chains: { [id: string]: Chain } = {};
  for (const chain of chains) {
    const additionalData = readAdditionalData(chain);

    __chains[chain.id] = {
      id: readConfigValue(chain.id),
      vmType: readConfigValue(chain.vmType),
      httpRpcUrl: readConfigValue(chain.httpRpcUrl),
      hubChainId: readConfigValue(chain.chainId),
      additionalData,
    };
  }

  return __chains;
};

export const getHubChain = async (chainId: string) => {
  const chains = await getHubChains();
  if (!chains[chainId]) {
    throw externalError(`Hub chain ${chainId} is not available`);
  }

  return chains[chainId];
};

export const getChainHubChainId = async (chainId: string) => {
  const hubChainId = await getChain(chainId).then((c) => c.hubChainId);
  if (!hubChainId) {
    throw externalError(`Chain ${chainId} has no hub chain id configured`);
  }

  return BigInt(hubChainId);
};

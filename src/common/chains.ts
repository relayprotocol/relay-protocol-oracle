import { VmType } from "@relay-protocol/settlement-sdk";

import { externalError } from "./error";
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
    // For "hyperliquid-vm"
    hubApiUrl?: string;
    // For "ethereum-vm"
    isZksyncStack?: boolean;
    // For "hub-vm"
    oracleAddress?: string;
  };
};

export const HUB_VM_TYPE = "hub-vm" as any as VmType;
export const HUB_CHAIN_ID = 0n;

let _chains: { [id: string]: Chain } | undefined;
export const getChains = async () => {
  if (!_chains) {
    const __chains: { [id: string]: Chain } = {};

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const chains = require(`../../configs/chains.${config.environment}.json`);
    for (const chain of chains) {
      const additionalData: any = {};
      if (chain.additionalData) {
        for (const [key, value] of Object.entries(
          (chain.additionalData ?? {}) as Record<string, any>,
        )) {
          additionalData[key] = readConfigValue(value);
        }
      }

      __chains[chain.id] = {
        id: readConfigValue(chain.id),
        vmType: readConfigValue(chain.vmType),
        httpRpcUrl: readConfigValue(chain.httpRpcUrl),
        depository: readConfigValue(chain.depository),
        hubChainId: readConfigValue(chain.hubChainId),
        additionalData,
      };
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
    const additionalData: any = {};
    if (chain.additionalData) {
      for (const [key, value] of Object.entries(
        (chain.additionalData ?? {}) as Record<string, any>,
      )) {
        additionalData[key] = readConfigValue(value);
      }
    }

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

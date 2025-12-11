import { VmType } from "@reservoir0x/relay-protocol-sdk";
import { externalError } from "./error";
import { readConfigValue } from "./utils";
import { config } from "../config";
import path from "path";
export const HUB_VM_TYPE = "hub-vm" as any as VmType;
export const HUB_CHAIN_ID = 0n;

export type Chain = {
  id: string;
  vmType: VmType;
  httpRpcUrl: string;
  depository?: string;
  additionalData?: any;
  // The numeric chain id in the onchain hub contract
  hubChainId?: string;
  chainId?: string;
};

let _chains: { [id: string]: Chain } | undefined;
export const getChains = async () => {
  if (!_chains) {
    const __chains: { [id: string]: Chain } = {};
    const chainsConfigPah = path.join(
      __dirname,
      `../configs/chains.${config.environment}`
    );
    const chains = require(chainsConfigPah);
    for (const chain of chains) {
      __chains[chain.id] = {
        id: readConfigValue(chain.id),
        vmType: readConfigValue(chain.vmType),
        httpRpcUrl: readConfigValue(chain.httpRpcUrl),
        depository: readConfigValue(chain.depository),
        hubChainId: readConfigValue(chain.hubChainId),
        additionalData: readConfigValue(chain.additionalData),
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
    Object.values(await getChains()).map((c) => [c.id, c.vmType])
  );
};

// helpers for hub chains
export const getHubChains = async () => {
  const hubEnv = config.environment.includes("prod") ? "prod" : "dev";
  const hubChainsConfigPath = path.join(
    __dirname,
    `../configs/chains.hub.${hubEnv}`
  );
  const chains = require(hubChainsConfigPath);

  const __chains: { [id: string]: Chain } = {};
  for (const chain of chains) {
    __chains[chain.id] = {
      id: readConfigValue(chain.id),
      vmType: readConfigValue(chain.vmType),
      httpRpcUrl: readConfigValue(chain.httpRpcUrl),
      hubChainId: readConfigValue(chain.hubChainId),
      additionalData: readConfigValue(chain.additionalData) || {},
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

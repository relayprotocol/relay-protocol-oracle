import { VmType } from "@reservoir0x/relay-protocol-sdk";

import { externalError } from "./error";
import { readConfigValue } from "./utils";
import { config } from "../config";

export type Chain = {
  id: string;
  vmType: VmType;
  httpRpcUrl: string;
  depository?: string;
  additionalData?: any;
};

let _chains: { [id: string]: Chain } | undefined;
export const getChains = async () => {
  if (!_chains) {
    const __chains: { [id: string]: Chain } = {};

    const chains = require(`../../configs/chains.${config.environment}.json`);
    for (const chain of chains) {
      __chains[chain.id] = {
        id: readConfigValue(chain.id),
        vmType: readConfigValue(chain.vmType),
        httpRpcUrl: readConfigValue(chain.httpRpcUrl),
        depository: readConfigValue(chain.depository),
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

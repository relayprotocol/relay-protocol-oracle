import { readConfigValue } from "./utils";
import { config } from "../config";

export enum ChainVmType {
  EthereumVM = "ethereum-vm",
}

export type Chain = {
  id: number;
  name: string;
  vmType: ChainVmType;
  httpRpcUrl: string;
  escrow: string;
};

let _chains: { [id: number]: Chain } | undefined;
export const getChains = async () => {
  if (!_chains) {
    const __chains: { [id: number]: Chain } = {};

    const chains = require(`../../configs/chains.${config.environment}.json`);
    for (const chain of chains) {
      __chains[chain.id] = {
        id: readConfigValue(chain.id),
        name: readConfigValue(chain.name),
        vmType: readConfigValue(chain.vmType),
        httpRpcUrl: readConfigValue(chain.httpRpcUrl),
        escrow: readConfigValue(chain.escrow),
      };
    }

    _chains = __chains;
  }

  return _chains;
};

export const getChain = async (chainId: number) => {
  const chains = await getChains();
  if (!chains[chainId]) {
    throw new Error(`Chain ${chainId} is not available`);
  }

  return chains[chainId];
};

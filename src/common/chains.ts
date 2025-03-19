import { db } from "./db";

export enum ChainVmType {
  EthereumVM = "ethereum-vm",
}

type CommonMetadata = {
  escrow: string;
};

type EthereumVMMetadata = {
  blockConfirmations: number;
};

type VMSpecificMetadata = EthereumVMMetadata;

export type Chain = {
  id: number;
  name: string;
  vmType: ChainVmType;
  httpRpcUrl: string;
  wsRpcUrl?: string;
  metadata: CommonMetadata & VMSpecificMetadata;
};

let _chains: { [id: number]: Chain } | undefined;
export const getChains = async () => {
  if (!_chains) {
    const __chains: { [id: number]: Chain } = {};

    const chains = await db.manyOrNone("SELECT * FROM chains");
    for (const chain of chains) {
      __chains[chain.id] = {
        id: Number(chain.id),
        name: chain.name,
        vmType: chain.vm_type,
        httpRpcUrl: chain.http_rpc_url,
        wsRpcUrl: chain.ws_rpc_url,
        metadata: chain.metadata,
      };
    }

    _chains = __chains;
  }

  return _chains;
};

export const getChain = async (chainId: number) => {
  const chains = await getChains();
  if (!chains[chainId]) {
    throw new Error(`Chain ${chainId} not available`);
  }

  return chains[chainId];
};

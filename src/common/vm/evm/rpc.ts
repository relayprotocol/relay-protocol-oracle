import { createPublicClient, http, webSocket } from "viem";

import { getChain } from "../../chains";

export const httpRpc = async (chainId: number) => {
  const chain = await getChain(chainId);
  return createPublicClient({
    chain: {
      id: chain.id,
      name: chain.name,
      nativeCurrency: {
        name: "Native",
        symbol: "NATIVE",
        decimals: 18,
      },
      rpcUrls: {
        default: {
          http: [chain.httpRpcUrl],
        },
      },
    },
    transport: http(),
  });
};

export const wsRpc = async (chainId: number) => {
  const chain = await getChain(chainId);
  if (!chain.wsRpcUrl) {
    return undefined;
  }

  return createPublicClient({
    chain: {
      id: chain.id,
      name: chain.name,
      nativeCurrency: {
        name: "Native",
        symbol: "NATIVE",
        decimals: 18,
      },
      rpcUrls: {
        default: {
          http: [chain.httpRpcUrl],
        },
      },
    },
    transport: webSocket(chain.wsRpcUrl),
  });
};

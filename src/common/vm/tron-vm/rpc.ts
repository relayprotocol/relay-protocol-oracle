import { TronWeb } from "tronweb";
import { createPublicClient, http } from "viem";

import { getChain } from "../../chains";

// The native Tron HTTP API exposes fields (eg. the transaction `data` memo) that
// the eth-compatible JSON-RPC does not. We derive its base url by stripping the
// trailing `/jsonrpc` segment from the configured RPC url.
export const httpTronRpc = async (chainId: string) => {
  const chain = await getChain(chainId);
  const fullHost = chain.httpRpcUrl.replace(/\/jsonrpc\/?$/, "");
  return new TronWeb({ fullHost });
};

export const httpRpc = async (chainId: string) => {
  const chain = await getChain(chainId);
  return createPublicClient({
    chain: {
      // We only need to `rpcUrls`, but viem makes all the other ones mandatory
      id: 0,
      name: "Chain",
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

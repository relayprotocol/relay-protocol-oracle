import { createPublicClient, http } from "viem";

import { getChain } from "../../chains";

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

import { createPublicClient, http, PublicClient } from "viem";
import { getHubChain } from "../../chains";

export const httpRpc = async (chainId: string): Promise<PublicClient> => {
  const chain = await getHubChain(chainId);
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

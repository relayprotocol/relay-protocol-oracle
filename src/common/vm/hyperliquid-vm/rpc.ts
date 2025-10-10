import * as hl from "@nktkas/hyperliquid";

import { getChain } from "../../chains";

export const httpRpc = async (chainId: string) => {
  const chain = await getChain(chainId);

  const transport = new hl.HttpTransport({
    isTestnet: chain.httpRpcUrl.includes("testnet"),
    server: {
      mainnet: {
        api: chain.httpRpcUrl,
        rpc: chain.httpRpcUrl.replace("api.", "rpc."),
      },
      testnet: {
        api: chain.httpRpcUrl,
        rpc: chain.httpRpcUrl.replace("api.", "rpc."),
      },
    },
    timeout: 5000,
  });

  return new hl.InfoClient({ transport });
};

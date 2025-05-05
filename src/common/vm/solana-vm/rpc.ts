import { Connection } from "@solana/web3.js";

import { getChain } from "../../chains";

export const httpRpc = async (chainId: string) => {
  const chain = await getChain(chainId);
  return new Connection(chain.httpRpcUrl);
};

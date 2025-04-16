import { TonClient } from "@ton/ton";

import { getChain } from "../../chains";

export const httpRpc = async (chainId: number) => {
  const chain = await getChain(chainId);
  return new TonClient({ endpoint: chain.httpRpcUrl });
};

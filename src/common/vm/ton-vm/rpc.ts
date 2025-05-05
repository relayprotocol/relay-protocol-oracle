import { TonClient } from "@ton/ton";

import { getChain } from "../../chains";

export const httpRpc = async (chainId: string) => {
  const chain = await getChain(chainId);
  return new TonClient({ endpoint: chain.httpRpcUrl });
};

import { SuiClient } from "@mysten/sui/client";

import { getChain } from "../../chains";

export const httpRpc = async (chainId: string) => {
  const chain = await getChain(chainId);
  return new SuiClient({ url: chain.httpRpcUrl });
};

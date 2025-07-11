import { MempoolSpaceConnection } from "./utils/mempool-space-connection";
import { RpcConnection } from "./utils/rpc-connection";
import { getChain } from "../../chains";

const createProvider = (rpcUrl: string) => {
  if (rpcUrl.includes("mempool.space")) {
    return new MempoolSpaceConnection(rpcUrl);
  }
  return new RpcConnection(rpcUrl);
};

export const httpRpc = async (chainId: string) => {
  const chain = await getChain(chainId);
  return createProvider(chain.httpRpcUrl);
};
  
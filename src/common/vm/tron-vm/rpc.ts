import * as tronweb from "tronweb";

import { getChain } from "../../chains";

export const httpRpc = async (chainId: string) => {
  const chain = await getChain(chainId);

  const randomKey = tronweb.TronWeb.createRandom().privateKey.slice(2);
  const rpc = new tronweb.TronWeb({
    fullHost: chain.httpRpcUrl,
    fullNode: new tronweb.providers.HttpProvider(chain.httpRpcUrl),
    privateKey: randomKey,
  });

  // https://github.com/tronprotocol/tronweb/issues/90
  rpc.setAddress(rpc.address.fromPrivateKey(randomKey) as string);

  return rpc;
};

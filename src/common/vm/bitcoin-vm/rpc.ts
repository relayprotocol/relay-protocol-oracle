import { bitcoin } from "@reservoir0x/relay-protocol-sdk";
import { getChain } from "../../chains";

export const httpRpc = async (chainId: string) => {
  const chain = await getChain(chainId);
  return bitcoin.createProvider(chain.httpRpcUrl);
};
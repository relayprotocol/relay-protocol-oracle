import { ApiClient, TransactionApi } from "@reservoir0x/lighter-ts-sdk";

import { getChain } from "../../chains";

export const httpRpc = async (chainId: string) => {
  const chain = await getChain(chainId);

  const apiClient = new ApiClient({ host: chain.httpRpcUrl });
  const transactionApi = new TransactionApi(apiClient);

  return {
    apiClient,
    transactionApi,
  };
};

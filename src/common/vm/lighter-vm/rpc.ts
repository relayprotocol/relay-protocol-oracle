import { ApiClient, TransactionApi } from "@reservoir0x/lighter-ts-sdk";

import { getChain } from "../../chains";

export const httpRpc = async (chainId: string) => {
  const chain = await getChain(chainId);

  const additionalHeaders = process.env.LIGHTER_PROXY_API_KEY
    ? { "x-api-key": process.env.LIGHTER_PROXY_API_KEY }
    : undefined;

  const apiClient = new ApiClient({
    host: chain.httpRpcUrl,
    additionalHeaders,
  });
  const transactionApi = new TransactionApi(apiClient);

  return {
    apiClient,
    transactionApi,
  };
};

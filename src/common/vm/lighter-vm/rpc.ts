import {
  AccountApi,
  ApiClient,
  TransactionApi,
} from "@reservoir0x/lighter-ts-sdk";

import { getChain } from "../../chains";

export const httpRpc = async (chainId: string) => {
  const chain = await getChain(chainId);

  const additionalHeaders = chain.additionalData?.rpcApiKey
    ? { "x-api-key": chain.additionalData?.rpcApiKey }
    : undefined;

  const apiClient = new ApiClient({
    host: chain.httpRpcUrl,
    additionalHeaders,
  });
  const accountApi = new AccountApi(apiClient);
  const transactionApi = new TransactionApi(apiClient);

  return {
    apiClient,
    accountApi,
    transactionApi,
  };
};

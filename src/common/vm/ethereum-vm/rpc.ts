import { createPublicClient, http } from "viem";

import { getChain } from "../../chains";

export const httpRpc = async (chainId: string) => {
  const chain = await getChain(chainId);

  // Handle RPCs which require basic authorization
  let basicAuthCredentials: { user: string; password: string } | undefined;
  const needsBasicAuth = chain.httpRpcUrl.includes("@");
  if (needsBasicAuth) {
    try {
      const parsedUrl = new URL(chain.httpRpcUrl);
      basicAuthCredentials = {
        user: parsedUrl.username,
        password: parsedUrl.password,
      };
    } catch {
      // Skip errors
    }
  }

  return createPublicClient({
    chain: {
      // We only need to `rpcUrls`, but viem makes all the other ones mandatory
      id: 0,
      name: "Chain",
      nativeCurrency: {
        name: "Native",
        symbol: "NATIVE",
        decimals: 18,
      },
      rpcUrls: {
        default: {
          http: [chain.httpRpcUrl],
        },
      },
    },
    transport: http(
      chain.httpRpcUrl,
      basicAuthCredentials
        ? {
            fetchOptions: {
              headers: {
                Authorization:
                  "Basic " +
                  Buffer.from(
                    basicAuthCredentials.user +
                      ":" +
                      basicAuthCredentials.password,
                  ).toString("base64"),
              },
            },
          }
        : undefined,
    ),
  });
};

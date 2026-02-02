import { createPublicClient, http } from "viem";

import { getChain } from "../../chains";

export const httpRpc = async (chainId: string) => {
  const chain = await getChain(chainId);

  let url = chain.httpRpcUrl;

  // Handle RPCs which require basic authorization
  let basicAuthCredentials: { user: string; password: string } | undefined;
  const needsBasicAuth = url.includes("@");
  if (needsBasicAuth) {
    try {
      const parsedUrl = new URL(url);
      basicAuthCredentials = {
        user: parsedUrl.username,
        password: parsedUrl.password,
      };

      // Overwrite the URL to not include the credentials (`fetch` will fail if credentials are set)
      url = parsedUrl.origin;
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
          http: [url],
        },
      },
    },
    transport: http(
      url,
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

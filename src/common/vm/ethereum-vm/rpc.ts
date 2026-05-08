import { createPublicClient, http, PublicClient } from "viem";

import { getChain } from "../../chains";

// Cache is keyed by chainId. Chain config is loaded once at startup
// (chains.ts `_chains` is never invalidated), so cached clients never go
// stale within a pod's lifetime; pod restart is the invalidation path.
const __cache = new Map<string, PublicClient>();

export const httpRpc = async (chainId: string): Promise<PublicClient> => {
  let client = __cache.get(chainId);
  if (client) return client;

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

  client = createPublicClient({
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
  __cache.set(chainId, client);
  return client;
};

// Test-only hooks
export const __resetCache = () => __cache.clear();
export const __getCacheSize = () => __cache.size;

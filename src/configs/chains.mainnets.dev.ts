import { parseNetwork, type ParseNetworkParams } from "./utils";

const chains: ParseNetworkParams[] = [
  "ethereum",
  "abstract",
  "optimism",
  "polygon",
  "base",
  "arbitrum",
].map((slug) => ({ slug, httpRpcUrl: "private" }));

module.exports = [
  ...chains,
  {
    slug: "solana",
    httpRpcUrl: "https://api.mainnet-beta.solana.com",
  },
  {
    slug: "hyperliquid",
    httpRpcUrl: "https://api.hyperliquid.xyz",
    additionalData: {
      hubApiUrl: "http://relay-protocol-hub.platform.svc.cluster.local",
    },
  },
].map((chain) => parseNetwork(chain));

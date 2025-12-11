import { parseNetwork, type ParseNetworkParams } from "./utils";
import { networks } from "@relay-protocol/networks";
import { NetworkConfig } from "@relay-protocol/types";

const chains: ParseNetworkParams[] = Object.values(networks)
  .filter(
    (network: NetworkConfig) => network.contracts?.dev?.oracle !== undefined
  )
  .map((network) => ({
    slug: network.slug,
    httpRpcUrl: network.rpc[0],
    isHub: true,
    additionalData: {
      oracleAddress: network.contracts?.dev?.oracle,
    },
  }));

module.exports = chains.map((chain) =>
  parseNetwork({ ...chain, env: "dev", isHub: true })
);

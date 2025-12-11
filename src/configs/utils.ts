import * as networks from "@relay-protocol/networks";
import { type NetworkConfig } from "@relay-protocol/types";
import { VmType } from "@reservoir0x/relay-protocol-sdk";
import type { Chain } from "../common/chains";

export type ParseNetworkParams = {
  slug: string;
  httpRpcUrl?: string | "private";
  env?: "dev" | "prod";
  additionalData?: Record<string, any>;
  isHub?: boolean;
};

export function parseNetwork({
  slug,
  httpRpcUrl,
  env = "dev",
  additionalData,
  isHub = false,
}: ParseNetworkParams): Chain {
  const network = Object.values(networks).find(
    (network: any) => network.slug === slug
  ) as NetworkConfig;

  if (!network) {
    throw Error(`Missing network in package ${slug}`);
  }

  let depository: string | undefined;
  let oracle: string | undefined;

  if (isHub) {
    const contracts = network.contracts?.[env as "dev" | "prod"];
    oracle = contracts?.oracle;

    if (!oracle) {
      throw Error(`Missing oracle address for ${slug} (env: ${env})`);
    }
  } else {
    const contracts = network.contracts?.[env as "dev" | "prod"];
    const depositoryAddress = contracts?.depository;

    // cast to lower case
    depository = !["solana-vm", "bitcoin-vm", "tron-vm"].includes(
      network.family
    )
      ? depositoryAddress!.toLowerCase()
      : depositoryAddress;

    if (!depository) {
      throw Error(`Missing depository address for ${slug} (env: ${env})`);
    }
  }

  // if provided, use httpRpcUrl
  // else if httpRpcUrl is set to "private", use private RPC pattern
  // else use network.rpc from npm package
  const rpcUrl =
    httpRpcUrl === "private"
      ? `http://proxy-${slug}.nodes.svc.cluster.local:8545/${slug}`
      : httpRpcUrl || (network.rpc && network.rpc[0]);

  if (!rpcUrl) {
    throw Error(`Missing RPC URL for ${slug}`);
  }

  return {
    id: network.slug || slug,
    vmType: isHub ? ("hub-vm" as VmType) : network.family,
    httpRpcUrl: rpcUrl,
    ...(depository && { depository }),
    ...(isHub
      ? { chainId: network.chainId.toString() }
      : network.hubChainId && { hubChainId: network.hubChainId.toString() }),
    additionalData: {
      ...(isHub && oracle && { oracleAddress: oracle }),
      ...(additionalData || {}),
    },
  };
}

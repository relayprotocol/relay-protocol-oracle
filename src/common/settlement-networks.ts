import { networks } from "@relay-protocol/settlement-networks";
import { VmType } from "@relay-protocol/settlement-sdk";

type SettlementNetworkConfig = {
  chainId?: bigint | number | string;
  family?: VmType;
  slug?: string;
  rpc?: string[];
  hubChainId?: string;
  contracts?: {
    prod?: {
      depository?: string;
    };
  };
};

type SettlementDefaultsIndex = {
  bySlug: Record<string, SettlementChainDefaults>;
  byChainId: Record<string, SettlementChainDefaults>;
};

export type SettlementChainDefaults = {
  id: string;
  vmType: VmType;
  httpRpcUrl?: string;
  depository?: string;
  hubChainId?: string;
};

const parseNetworkDefaults = (
  network: SettlementNetworkConfig,
): { chainId?: string; defaults: SettlementChainDefaults } | undefined => {
  if (!network.slug || !network.family) {
    return undefined;
  }

  const chainId =
    typeof network.chainId === "bigint" ||
    typeof network.chainId === "number" ||
    typeof network.chainId === "string"
      ? network.chainId.toString()
      : undefined;
  const httpRpcUrl = network.rpc?.find(
    (url): url is string => typeof url === "string" && Boolean(url.trim()),
  );
  const depository = network.contracts?.prod?.depository;
  return {
    chainId,
    defaults: {
      id: network.slug,
      vmType: network.family,
      httpRpcUrl,
      depository,
      hubChainId: network.hubChainId ?? chainId,
    },
  };
};

const buildSettlementDefaultsIndex = (
  networksMap: Record<string, SettlementNetworkConfig>,
): SettlementDefaultsIndex => {
  const bySlug: Record<string, SettlementChainDefaults> = {};
  const byChainId: Record<string, SettlementChainDefaults> = {};

  for (const network of Object.values(networksMap)) {
    const parsed = parseNetworkDefaults(
      (network ?? {}) as SettlementNetworkConfig,
    );
    if (!parsed) {
      continue;
    }

    bySlug[parsed.defaults.id] = parsed.defaults;
    if (parsed.chainId) {
      byChainId[parsed.chainId] = parsed.defaults;
    }
  }

  return { bySlug, byChainId };
};

const settlementDefaults = buildSettlementDefaultsIndex(
  networks as Record<string, SettlementNetworkConfig>,
);

export const getSettlementChainDefaultsForChain = (
  chainId: string,
  localHubChainId?: string,
): SettlementChainDefaults | undefined => {
  if (settlementDefaults.bySlug[chainId]) {
    return settlementDefaults.bySlug[chainId];
  }
  if (settlementDefaults.byChainId[chainId]) {
    return settlementDefaults.byChainId[chainId];
  }
  if (localHubChainId && settlementDefaults.byChainId[localHubChainId]) {
    return settlementDefaults.byChainId[localHubChainId];
  }

  return undefined;
};

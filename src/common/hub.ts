import { RelayOracle, RelayHub } from "@relay-protocol/abis";
import {
  Address,
  createPublicClient,
  getContract,
  GetContractReturnType,
  http,
  PublicClient,
} from "viem";

import { getHubInfo } from "./chains";

let __cachedHubHttpRpc: PublicClient | undefined;
let __cachedAuroraHttpRpc: PublicClient | undefined;
let __cachedOracleContract:
  | GetContractReturnType<typeof RelayOracle, PublicClient>
  | undefined;
let __cachedHubContract:
  | GetContractReturnType<typeof RelayHub, PublicClient>
  | undefined;

export const getHubHttpRpc = async (): Promise<PublicClient> => {
  if (!__cachedHubHttpRpc) {
    const hubInfo = await getHubInfo();
    __cachedHubHttpRpc = createPublicClient({
      chain: {
        id: Number(hubInfo.evmChainId),
        name: "Hub",
        nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
        rpcUrls: {
          default: { http: [hubInfo.httpRpcUrl] },
        },
      },
      transport: http(),
    });
  }
  return __cachedHubHttpRpc;
};

export const getAuroraHttpRpc = async (): Promise<PublicClient> => {
  if (!__cachedAuroraHttpRpc) {
    const hubInfo = await getHubInfo();
    __cachedAuroraHttpRpc = createPublicClient({
      chain: {
        id: Number(hubInfo.auroraEvmChainId),
        name: "Aurora",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: {
          default: { http: [hubInfo.auroraHttpRpcUrl] },
        },
      },
      transport: http(),
    });
  }
  return __cachedAuroraHttpRpc;
};

const getOracleContract = async () => {
  if (!__cachedOracleContract) {
    const hubInfo = await getHubInfo();
    __cachedOracleContract = getContract({
      address: hubInfo.oracleAddress as Address,
      abi: RelayOracle,
      client: await getHubHttpRpc(),
    });
  }
  return __cachedOracleContract;
};

const getHubContract = async () => {
  if (!__cachedHubContract) {
    const oracleContract = await getOracleContract();
    const hubAddress = await oracleContract.read.HUB();
    __cachedHubContract = getContract({
      address: hubAddress as Address,
      abi: RelayHub,
      client: await getHubHttpRpc(),
    });
  }
  return __cachedHubContract;
};

export const getBalanceOnHub = async (address: string, hubTokenId: bigint) => {
  const hubContract = await getHubContract();
  return (await hubContract.read.balanceOf([
    address as Address,
    hubTokenId,
  ])) as bigint;
};

// Test-only — reset all four caches together. Partial resets are unsafe:
// __cachedOracleContract / __cachedHubContract hold a getHubHttpRpc reference,
// so resetting only the http rpc would leave them with the released client.
export const __resetHubCache = () => {
  __cachedHubHttpRpc = undefined;
  __cachedAuroraHttpRpc = undefined;
  __cachedOracleContract = undefined;
  __cachedHubContract = undefined;
};

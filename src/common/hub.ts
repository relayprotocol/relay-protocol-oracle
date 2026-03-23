import { RelayOracle, RelayHub } from "@relay-protocol/abis";
import { Address, createPublicClient, getContract, http } from "viem";

import { getHubInfo } from "./chains";

export const getHubHttpRpc = async () => {
  const hubInfo = await getHubInfo();

  return createPublicClient({
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
};

export const getAuroraHttpRpc = async () => {
  const hubInfo = await getHubInfo();

  return createPublicClient({
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
};

const getOracleContract = async () => {
  const hubInfo = await getHubInfo();
  return getContract({
    address: hubInfo.oracleAddress as Address,
    abi: RelayOracle,
    client: await getHubHttpRpc(),
  });
};

const getHubContract = async () => {
  const oracleContract = await getOracleContract();
  const hubAddress = await oracleContract.read.HUB();
  return getContract({
    address: hubAddress as Address,
    abi: RelayHub,
    client: await getHubHttpRpc(),
  });
};

export const getBalanceOnHub = async (address: string, hubTokenId: bigint) => {
  const hubContract = await getHubContract();
  return (await hubContract.read.balanceOf([
    address as Address,
    hubTokenId,
  ])) as bigint;
};

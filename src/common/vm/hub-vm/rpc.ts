import {
  createPublicClient,
  http,
  PublicClient,
  getContract,
  Address,
} from "viem";
import { getHubChain } from "../../chains";
import { RelayOracle, RelayHub } from "@relay-protocol/abis";

export const httpRpc = async (chainId: string): Promise<PublicClient> => {
  const chain = await getHubChain(chainId);
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
    transport: http(),
  });
};

export const getOracleContract = async (chainId: string) => {
  const chain = await getHubChain(chainId);
  return getContract({
    address: chain.additionalData!.oracleAddress as Address,
    abi: RelayOracle,
    client: await httpRpc(chainId),
  });
};

export const getHubContract = async (chainId: string) => {
  const oracleContract = await getOracleContract(chainId);
  const hubAddress = await oracleContract.read.HUB();
  return getContract({
    address: hubAddress as Address,
    abi: RelayHub,
    client: await httpRpc(chainId),
  });
};

export const getHubBlockNumber = async (chainId: string) => {
  const client = await httpRpc(chainId);
  const blockNumber = await client.getBlockNumber();
  return blockNumber;
};

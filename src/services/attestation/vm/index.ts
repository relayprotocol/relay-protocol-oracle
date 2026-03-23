import { VmAttestor } from "./types";
import { getChain } from "../../../common/chains";
import { externalError } from "../../../common/error";

import { EthereumVmAttestor } from "./ethereum-vm";
import { BitcoinVmAttestor } from "./bitcoin-vm";
import { HyperliquidVmAttestor } from "./hyperliquid-vm";
import { LighterVmAttestor } from "./lighter-vm";
import { SolanaVmAttestor } from "./solana-vm";
import { SuiVmAttestor } from "./sui-vm";
import { TronVmAttestor } from "./tron-vm";

export const getVmAttestor = async (chainId: string): Promise<VmAttestor> => {
  const chain = await getChain(chainId);
  switch (chain.vmType) {
    case "ethereum-vm":
      return new EthereumVmAttestor();

    case "hyperliquid-vm":
      return new HyperliquidVmAttestor();

    case "lighter-vm":
      return new LighterVmAttestor();

    case "solana-vm":
      return new SolanaVmAttestor();

    case "sui-vm":
      return new SuiVmAttestor();

    case "bitcoin-vm":
      return new BitcoinVmAttestor();

    case "tron-vm":
      return new TronVmAttestor();

    default:
      throw externalError("Vm type not implemented");
  }
};

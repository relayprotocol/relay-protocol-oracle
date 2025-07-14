import { VmAttestor } from "./types";
import { getChain } from "../../../common/chains";
import { externalError } from "../../../common/error";

import { EthereumVmAttestor } from "./ethereum-vm";
import { HyperliquidVmAttestor } from "./hyperliquid-vm";
import { SolanaVmAttestor } from "./solana-vm";
import { SuiVmAttestor } from "./sui-vm";
import { TonVmAttestor } from "./ton-vm";
import { BitcoinVmAttestor } from "./bitcoin-vm";

export const getVmAttestor = async (chainId: string): Promise<VmAttestor> => {
  const chain = await getChain(chainId);
  switch (chain.vmType) {
    case "ethereum-vm":
      return new EthereumVmAttestor();

    case "hyperliquid-vm":
      return new HyperliquidVmAttestor();

    case "solana-vm":
      return new SolanaVmAttestor();

    case "sui-vm":
      return new SuiVmAttestor();

    case "ton-vm":
      return new TonVmAttestor();

    case "bitcoin-vm":
      return new BitcoinVmAttestor();

    default:
      throw externalError("Vm type not implemented");
  }
};

import { VmAttestor } from "./types";
import { getChain } from "../../../common/chains";
import { externalError } from "../../../common/error";

import { EthereumVmAttestor } from "./ethereum-vm";
import { BitcoinVmAttestor } from "./bitcoin-vm";
import { HyperliquidVmAttestor } from "./hyperliquid-vm";
import { LighterVmAttestor } from "./lighter-vm";
import { SolanaVmAttestor } from "./solana-vm";
import { TonVmAttestor } from "./ton-vm";
import { TronVmAttestor } from "./tron-vm";
import { XrpVmAttestor } from "./xrp-vm";

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

    case "bitcoin-vm":
      return new BitcoinVmAttestor();

    case "ton-vm":
      return new TonVmAttestor();

    case "tron-vm":
      return new TronVmAttestor();

    case "xrp-vm":
      return new XrpVmAttestor();

    default:
      throw externalError("Vm type not implemented");
  }
};

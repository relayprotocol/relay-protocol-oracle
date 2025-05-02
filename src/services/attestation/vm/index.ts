import { VmAttestor } from "./types";
import { getChain } from "../../../common/chains";
import { externalError } from "../../../common/error";

import { EthereumVmAttestor } from "./ethereum-vm";
import { SolanaVmAttestor } from "./solana-vm";
import { SuiVmAttestor } from "./sui-vm";
import { TonVmAttestor } from "./ton-vm";

export const getVmAttestor = async (chainId: string): Promise<VmAttestor> => {
  const chain = await getChain(chainId);
  switch (chain.vmType) {
    case "ethereum-vm":
      return new EthereumVmAttestor();

    case "solana-vm":
      return new SolanaVmAttestor();

    case "sui-vm":
      return new SuiVmAttestor();

    case "ton-vm":
      return new TonVmAttestor();

    default:
      throw externalError("Vm type not implemented");
  }
};

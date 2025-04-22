import { AttestationService } from "./attestation/service";
import { getChain } from "../common/chains";
import { externalError } from "../common/error";

import { EvmAttestationService } from "./attestation/ethereum-vm";

export const getAttestationService = async (
  chainId: number
): Promise<AttestationService> => {
  const chain = await getChain(chainId);
  switch (chain.vmType) {
    case "ethereum-vm":
      return new EvmAttestationService();

    default:
      throw externalError("Vm type not implemented");
  }
};

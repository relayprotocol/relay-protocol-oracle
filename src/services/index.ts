import { AttestationService } from "./attestation/service";
import { ChainVmType, getChain } from "../common/chains";
import { safeError } from "../common/error";

import { EvmAttestationService } from "./attestation/evm";

export const getAttestationService = async (
  chainId: number
): Promise<AttestationService> => {
  const chain = await getChain(chainId);
  switch (chain.vmType) {
    case ChainVmType.EthereumVM:
      return new EvmAttestationService();

    default:
      throw safeError("Vm type not implemented");
  }
};

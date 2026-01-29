import { Address } from "viem";

import { getHubContract } from "../../../../common/vm/hub-vm/rpc";

// This does not extend VmAttestor as fewer methods are required for now
export class HubVmAttestor {
  async getBalanceOnHub(
    hubChainId: string,
    address: string,
    hubTokenId: bigint,
  ): Promise<string> {
    const hubContract = await getHubContract(hubChainId);
    const balance = (await hubContract.read.balanceOf([
      address as Address,
      hubTokenId,
    ])) as bigint;
    return balance.toString();
  }
}

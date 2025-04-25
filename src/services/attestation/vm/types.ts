import { ProtocolMessage } from "../utils";

export abstract class VmAttestor {
  public abstract getEscrowMessages(
    chainId: number,
    transactionId: string
  ): Promise<ProtocolMessage[]>;

  public abstract getSolverPaidAmount(
    chainId: number,
    transactionId: string,
    payment: {
      currency: string;
      recipient: string;
      orderHash: string;
      extraData: string;
      deadline: number;
    }
  ): Promise<bigint>;
}

import {
  EscrowDepositMessage,
  EscrowWithdrawalMessage,
} from "@reservoir0x/relay-protocol-sdk";

export abstract class VmAttestor {
  public abstract getEscrowDepositMessages(
    chainId: number,
    transactionId: string
  ): Promise<EscrowDepositMessage[]>;

  public abstract getEscrowWithdrawalStatus(
    chainId: number,
    withdrawal: string
  ): Promise<EscrowWithdrawalMessage>;

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

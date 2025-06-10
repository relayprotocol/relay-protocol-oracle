import {
  EscrowDepositMessage,
  EscrowWithdrawalMessage,
} from "@reservoir0x/relay-protocol-sdk";

export abstract class VmAttestor {
  public abstract getEscrowDepositMessages(
    chainId: string,
    transactionId: string
  ): Promise<EscrowDepositMessage[]>;

  public abstract getEscrowWithdrawalMessage(
    chainId: string,
    withdrawal: string
  ): Promise<EscrowWithdrawalMessage>;

  public abstract getSolverPaidAmount(
    chainId: string,
    transactionId: string,
    payment: {
      currency: string;
      recipient: string;
      orderHash: string;
      extraData: string;
      deadline: number;
    }
  ): Promise<bigint>;

  public abstract verifySolverCalls(
    chainId: string,
    transactionId: string,
    calls: string[],
    extraData: string
  ): Promise<boolean>;
}

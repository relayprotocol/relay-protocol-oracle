import {
  DepositoryDepositMessage,
  DepositoryWithdrawalMessage,
} from "@reservoir0x/relay-protocol-sdk";

export abstract class VmAttestor {
  public abstract getDepositoryDepositMessages(
    chainId: string,
    transactionId: string
  ): Promise<DepositoryDepositMessage[]>;

  public abstract getDepositoryWithdrawalMessage(
    chainId: string,
    withdrawal: string
  ): Promise<DepositoryWithdrawalMessage>;

  public abstract getSolverPaidAmount(
    chainId: string,
    transactionId: string,
    payment: {
      currency: string;
      recipient: string;
      orderId: string;
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

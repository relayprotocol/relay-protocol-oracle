import {
  DepositoryDepositMessage,
  DepositoryWithdrawalMessage,
} from "@reservoir0x/relay-protocol-sdk";

import { TxHints } from "..";

export type EnhancedDepositoryDepositMessage = DepositoryDepositMessage & {
  extraData: {
    timestamp: string;
  };
};

export abstract class VmAttestor {
  public abstract getDepositoryDepositMessages(
    chainId: string,
    transactionId: string
  ): Promise<EnhancedDepositoryDepositMessage[]>;

  public abstract getDepositoryWithdrawalMessage(
    chainId: string,
    withdrawal: string,
    transactionId?: string
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
    },
    hints?: TxHints
  ): Promise<bigint>;

  public abstract verifySolverCalls(
    chainId: string,
    transactionId: string,
    calls: string[],
    extraData: string
  ): Promise<boolean>;
}

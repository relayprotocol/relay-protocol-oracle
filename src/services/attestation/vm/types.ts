import {
  DenormalizedSubmitWithdrawRequest,
  DepositoryDepositMessage,
  DepositoryWithdrawalMessage,
} from "@relay-protocol/settlement-sdk";

import type { TxHints } from "..";

export type DepositMode = "fast" | "slow";

// Measured finality for a deposit transaction (block-count + wall-clock)
export type DepositFinality = {
  // Blocks between the deposit transaction and the chain tip
  confirmations: number;
  // Wall-clock seconds since the deposit block
  elapsedSeconds: number;
  // Deposit block timestamp (epoch seconds)
  timestamp: string;
};

export type EnhancedDepositoryDepositMessage = DepositoryDepositMessage & {
  extraData: {
    timestamp: string;
    mode?: DepositMode;
    fastFeeBps?: string;
  };
};

export abstract class VmAttestor {
  public abstract getDepositoryDepositMessages(
    chainId: string,
    transactionId: string,
    hints?: TxHints,
    opts?: { mode?: DepositMode },
  ): Promise<EnhancedDepositoryDepositMessage[]>;

  public abstract getDepositoryWithdrawalMessage(
    chainId: string,
    withdrawal: string,
    transactionId?: string,
    hints?: TxHints,
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
    hints?: TxHints,
  ): Promise<bigint>;

  public abstract verifySolverCalls(
    chainId: string,
    transactionId: string,
    calls: string[],
    extraData: string,
  ): Promise<boolean>;

  public validateSubmitWithdrawRequest(
    _data: DenormalizedSubmitWithdrawRequest,
  ): Promise<boolean> {
    return new Promise((resolve) => resolve(true));
  }
}

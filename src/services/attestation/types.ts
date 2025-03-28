export type EscrowDepositMessage = {
  kind: "escrow-deposit";
  messageId: string;
  input: {
    chainId: number;
    transactionId: string;
  };
  output: {
    escrow: string;
    depositor: string;
    currency: string;
    amount: string;
    id?: string;
  };
};

export type EscrowWithdrawalMessage = {
  kind: "escrow-withdrawal";
  messageId: string;
  input: {
    chainId: number;
    transactionId: string;
  };
  output: {
    escrow: string;
    currency: string;
    amount: string;
    id?: string;
  };
};

export type AttestationMessage = EscrowDepositMessage | EscrowWithdrawalMessage;

export abstract class AttestationService {
  public abstract attestEscrowDeposits(
    chainId: number,
    transactionId: string
  ): Promise<AttestationMessage[]>;

  public abstract attestEscrowWithdrawals(
    chainId: number,
    transactionId: string
  ): Promise<AttestationMessage[]>;
}

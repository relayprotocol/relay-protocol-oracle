import type { Order } from "@reservoir0x/relay-protocol-sdk";

export type EscrowDepositMessage = {
  kind: "escrow-deposit";
  messageId: string;
  data: {
    chainId: number;
    transactionId: string;
  };
  result: {
    id?: string;
    escrow: string;
    depositor: string;
    currency: string;
    amount: string;
  };
};

export type EscrowWithdrawalMessage = {
  kind: "escrow-withdrawal";
  messageId: string;
  data: {
    chainId: number;
    transactionId: string;
  };
  result: {
    id?: string;
    escrow: string;
    currency: string;
    amount: string;
  };
};

export type SolverFillMessage = {
  kind: "solver-fill";
  messageId: string;
  data: {
    order: Order;
    orderSignature: string;
    inputs: {
      transactionId: string;
      inputIndex: number;
    }[];
    output:
      | {
          status: "success";
          fill: {
            transactionId: string;
          };
        }
      | {
          status: "refund";
          refunds: {
            transactionId: string;
            inputIndex: number;
            refundIndex: number;
          }[];
        };
  };
  result: {
    valid: boolean;
  };
};

export type AttestationMessage =
  | EscrowDepositMessage
  | EscrowWithdrawalMessage
  | SolverFillMessage;

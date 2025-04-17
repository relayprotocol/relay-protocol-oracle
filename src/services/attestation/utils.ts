import {
  EscrowDepositMessage,
  EscrowWithdrawalMessage,
  SolverRefundFillMessage,
  SolverSuccessFillMessage,
} from "@reservoir0x/relay-protocol-sdk";
import crypto from "crypto";

export type ProtocolMessage =
  | {
      type: "escrow-deposit";
      message: EscrowDepositMessage;
    }
  | {
      type: "escrow-withdrawal";
      message: EscrowWithdrawalMessage;
    }
  | {
      type: "solver-success-fill";
      message: SolverSuccessFillMessage;
    }
  | {
      type: "solver-refund-fill";
      message: SolverRefundFillMessage;
    };

export const getOnchainId = (
  chainId: number,
  transactionId: string,
  entryId: string
) =>
  "0x" +
  crypto
    .createHash("sha256")
    .update(`${chainId}:${transactionId}:${entryId}`.toLowerCase())
    .digest("hex");

import {
  TransactionType,
  TransactionStatus,
} from "@reservoir0x/lighter-ts-sdk";
import {
  DepositoryWithdrawalMessage,
  getVmTypeNativeCurrency,
} from "@reservoir0x/relay-protocol-sdk";

import { EnhancedDepositoryDepositMessage, VmAttestor } from "../types";
import { externalError, internalError } from "../../../../common/error";
import { httpRpc } from "../../../../common/vm/lighter-vm/rpc";

const VM_TYPE = "lighter-vm";

type TransferTxInfo = {
  FromAccountIndex: number;
  ApiKeyIndex: number;
  ToAccountIndex: number;
  USDCAmount: number;
  Fee: number;
  Memo: number[];
  ExpiredAt: number;
  Nonce: number;
  Sig: string;
  L1Sig: string;
};

export class LighterVmAttestor extends VmAttestor {
  public async getDepositoryDepositMessages(
    _chainId: string,
    _transactionId: string
  ): Promise<EnhancedDepositoryDepositMessage[]> {
    throw internalError("Not implemented (getDepositoryDepositMessages)");
  }

  public async getDepositoryWithdrawalMessage(
    _chainId: string,
    _withdrawal: string,
    _transactionId?: string
  ): Promise<DepositoryWithdrawalMessage> {
    throw internalError("Not implemented (getDepositoryWithdrawalMessage)");
  }

  public async getSolverPaidAmount(
    chainId: string,
    transactionId: string,
    payment: {
      currency: string;
      recipient: string;
      orderId: string;
      extraData: string;
      deadline: number;
    }
  ): Promise<bigint> {
    const { transactionApi } = await httpRpc(chainId);

    // Get transaction details
    const txDetail = await transactionApi.getTransaction({
      by: "hash",
      value: transactionId,
    });
    if (!txDetail) {
      throw externalError(
        `Missing transaction ${transactionId} on chain ${chainId}`
      );
    }

    // Check transaction status
    if (
      txDetail.status !== TransactionStatus.COMMITTED &&
      txDetail.status !== TransactionStatus.EXECUTED
    ) {
      throw externalError(`Missing or reverted transaction ${transactionId}`);
    }

    // Check transaction deadline
    if (!txDetail.queued_at) {
      throw externalError(`Missing or reverted transaction ${transactionId}`);
    }
    const transactionTimestamp = Math.floor(txDetail.queued_at / 1000);
    if (transactionTimestamp > payment.deadline) {
      throw externalError(
        `Transaction ${transactionId} executed after deadline`
      );
    }

    // Verify payment - only USDC transfers are currently supported
    if (
      payment.currency !== getVmTypeNativeCurrency(VM_TYPE) ||
      txDetail.type !== TransactionType.TRANSFER
    ) {
      throw externalError("Could not detect payment");
    }

    // Parse and verify transaction info
    let transferInfo: TransferTxInfo;
    if (!txDetail.info) {
      throw externalError("Could not detect payment");
    }
    transferInfo = JSON.parse(txDetail.info);

    // Verify the recipient matches
    const recipientAccountIndex = parseInt(payment.recipient);
    if (
      isNaN(recipientAccountIndex) ||
      transferInfo.ToAccountIndex !== recipientAccountIndex
    ) {
      throw externalError("Could not detect payment");
    }

    return BigInt(transferInfo.USDCAmount);
  }

  public async verifySolverCalls(
    _chainId: string,
    _transactionId: string,
    _calls: string[],
    _extraData: string
  ): Promise<boolean> {
    throw internalError("Not implemented (verifySolverCalls)");
  }
}

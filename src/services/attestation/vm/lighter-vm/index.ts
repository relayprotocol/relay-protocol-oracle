import {
  TransactionType,
  TransactionStatus,
} from "@reservoir0x/lighter-ts-sdk";
import {
  DepositoryWithdrawalMessage,
  getVmTypeNativeCurrency,
} from "@relay-protocol/settlement-sdk";

import { EnhancedDepositoryDepositMessage, VmAttestor } from "../types";
import { externalError, internalError } from "../../../../common/error";
import { getTrackingId, logRpcUsage } from "../../../../common/rpc-usage";
import { httpRpc } from "../../../../common/vm/lighter-vm/rpc";

const VM_TYPE = "lighter-vm";

type TransferTxInfo = {
  FromAccountIndex: number;
  ApiKeyIndex: number;
  ToAccountIndex: number;
  AssetIndex: number;
  FromRouteType: number;
  ToRouteType: number;
  Amount: number;
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
    const trackingId = getTrackingId();

    const { transactionApi } = await httpRpc(chainId);

    // Get transaction details
    await logRpcUsage(chainId, "getTransaction", trackingId);
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

    // Verify payment
    if (txDetail.type !== TransactionType.TRANSFER) {
      throw externalError("Could not detect payment");
    }

    // Parse and verify transaction info
    let transferInfo: TransferTxInfo;
    if (!txDetail.info) {
      throw externalError("Could not detect payment");
    }
    transferInfo = JSON.parse(txDetail.info);

    let transferCurrency: string;
    if (transferInfo.AssetIndex === 1) {
      // ETH

      if (transferInfo.ToRouteType !== 1) {
        throw externalError("Could not detect payment");
      }

      // Spot ETH
      transferCurrency = transferInfo.AssetIndex.toString();
    } else if (transferInfo.AssetIndex === 3) {
      // USDC

      if (transferInfo.ToRouteType === 0) {
        // Perps USDC
        transferCurrency = getVmTypeNativeCurrency(VM_TYPE);
      } else if (transferInfo.ToRouteType === 1) {
        // Spot USDC
        transferCurrency = transferInfo.AssetIndex.toString();
      } else {
        throw externalError("Could not detect payment");
      }
    } else {
      throw externalError("Could not detect payment");
    }

    if (payment.currency !== transferCurrency) {
      throw externalError("Could not detect payment");
    }

    // Verify the recipient matches
    const recipientAccountIndex = parseInt(payment.recipient);
    if (
      isNaN(recipientAccountIndex) ||
      transferInfo.ToAccountIndex !== recipientAccountIndex
    ) {
      throw externalError("Could not detect payment");
    }

    return BigInt(transferInfo.Amount);
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

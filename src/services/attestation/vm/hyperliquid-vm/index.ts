import * as hl from "@nktkas/hyperliquid";
import {
  DepositoryWithdrawalMessage,
  getVmTypeNativeCurrency,
} from "@reservoir0x/relay-protocol-sdk";
import { Hex, parseUnits } from "viem";

import { EnhancedDepositoryDepositMessage, VmAttestor } from "../../vm/types";
import { externalError, internalError } from "../../../../common/error";
import { httpRpc } from "../../../../common/vm/hyperliquid-vm/rpc";

const VM_TYPE = "hyperliquid-vm";

export class HyperliquidVmAttestor extends VmAttestor {
  public async getDepositoryDepositMessages(
    _chainId: string,
    _transactionId: string
  ): Promise<EnhancedDepositoryDepositMessage[]> {
    throw internalError("Not implemented (getDepositoryDepositMessages)");
  }

  public async getDepositoryWithdrawalMessage(
    _chainId: string,
    _withdrawal: string
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
    const rpc = await httpRpc(chainId);

    // Ensure the transaction was successfully included
    const txDetails = await rpc.txDetails({
      hash: transactionId as Hex,
    });
    if (!txDetails || txDetails.error) {
      throw externalError(`Missing or reverted transaction ${transactionId}`);
    }

    const transactionTimestamp = Math.floor(txDetails.time / 1000);
    if (transactionTimestamp > payment.deadline) {
      throw externalError(
        `Transaction ${transactionId} executed after deadline`
      );
    }

    if (payment.currency === getVmTypeNativeCurrency(VM_TYPE)) {
      if (txDetails.action.type === "usdSend") {
        const txParameters =
          txDetails.action as unknown as hl.UsdSendParameters;
        if (
          txParameters.destination.toLowerCase() ===
          payment.recipient.toLowerCase()
        ) {
          return parseUnits(Number(txParameters.amount).toFixed(8), 8);
        }
      }

      return BigInt(0);
    } else {
      throw internalError("Unsupported payment currency");
    }
  }

  public async verifySolverCalls(
    _chainId: string,
    _transactionId: string,
    _calls: string[]
  ): Promise<boolean> {
    throw internalError("Not implemented (verifySolverCalls)");
  }
}

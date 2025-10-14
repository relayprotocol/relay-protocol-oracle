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
    if (!txDetails || txDetails.tx.error) {
      throw externalError(`Missing or reverted transaction ${transactionId}`);
    }

    const transactionTimestamp = Math.floor(txDetails.tx.time / 1000);
    if (transactionTimestamp > payment.deadline) {
      throw externalError(
        `Transaction ${transactionId} executed after deadline`
      );
    }

    if (payment.currency === getVmTypeNativeCurrency(VM_TYPE)) {
      if (txDetails.tx.action.type === "usdSend") {
        const txParameters = txDetails.tx
          .action as unknown as hl.UsdSendParameters;
        if (
          txParameters.destination.toLowerCase() ===
          payment.recipient.toLowerCase()
        ) {
          return parseUnits(Number(txParameters.amount).toFixed(8), 8);
        }
      }

      throw externalError("Could not detect payment");
    } else {
      if (txDetails.tx.action.type === "sendAsset") {
        const txParameters = txDetails.tx
          .action as unknown as hl.SendAssetParameters;

        const [orderPaymentCurrency, orderPaymentDex] = [
          payment.currency.slice(0, 34),
          payment.currency.slice(34) === ""
            ? "spot"
            : Buffer.from(payment.currency.slice(34), "hex").toString("ascii"),
        ];
        const [actualPaymentCurrency, actualPaymentDex] = [
          txParameters.token.split(":")[1],
          txParameters.destinationDex,
        ];

        if (
          txParameters.destination.toLowerCase() ===
            payment.recipient.toLowerCase() &&
          orderPaymentCurrency.toLowerCase() ===
            actualPaymentCurrency.toLowerCase() &&
          orderPaymentDex === actualPaymentDex
        ) {
          const currencyDecimals = await rpc
            .spotMeta()
            .then(
              (r) =>
                r.tokens.find((t) => t.tokenId === actualPaymentCurrency)
                  ?.szDecimals
            );
          if (currencyDecimals === undefined) {
            throw externalError("Could not retrieve payment currency decimals");
          }

          return parseUnits(Number(txParameters.amount).toFixed(8), 8);
        }
      }

      throw externalError("Could not detect payment");
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

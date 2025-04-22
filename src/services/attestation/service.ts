import {
  EscrowDepositMessage,
  EscrowWithdrawalMessage,
  getOrderHash,
  Order,
  SolverRefundFillMessage,
  SolverSuccessFillMessage,
} from "@reservoir0x/relay-protocol-sdk";
import { Address, Hex, verifyMessage } from "viem";

import { ProtocolMessage } from "./utils";
import { getSdkChainsConfig } from "../../common/chains";
import { externalError } from "../../common/error";

export abstract class AttestationService {
  // Public methods

  public async attestEscrowDeposits(
    data: EscrowDepositMessage["data"]
  ): Promise<EscrowDepositMessage[]> {
    return this.getEscrowMessages(data.chainId, data.transactionId).then(
      (messages) =>
        messages
          .filter((m) => m.type === "escrow-deposit")
          .map((m) => m.message)
    );
  }

  public async attestEscrowWithdrawals(
    data: EscrowWithdrawalMessage["data"]
  ): Promise<EscrowWithdrawalMessage[]> {
    return this.getEscrowMessages(data.chainId, data.transactionId).then(
      (messages) =>
        messages
          .filter((m) => m.type === "escrow-withdrawal")
          .map((m) => m.message)
    );
  }

  public async attestSolverSuccessFill(data: SolverSuccessFillMessage["data"]) {
    const underpaymentBps = await this.getUnderpaymentBps(data);

    const orderHash = getOrderHash(data.order, await getSdkChainsConfig());

    // Verify the fill
    for (
      let paymentIndex = 0;
      paymentIndex < data.order.output.payments.length;
      paymentIndex++
    ) {
      const payment = data.order.output.payments[paymentIndex];

      const paidAmount = await this.getSolverPaidAmount(
        data.order.output.chainId,
        data.fill.transactionId,
        {
          currency: payment.currency,
          recipient: payment.recipient,
          orderHash,
          extraData: data.order.output.extraData,
          deadline: data.order.output.deadline,
        }
      );

      // Ensure the paid amount matches the minimum amount requested by the user (adjusted for any underpayment)
      if (
        paidAmount <
        payment.minimumAmount -
          (payment.minimumAmount * underpaymentBps) / 10n ** 18n
      ) {
        throw externalError(
          `Insufficient amount for output payment ${paymentIndex}`
        );
      }
    }

    if (data.order.output.calls.length) {
      // TODO: Ensure any output calls were executed
    }
  }

  public async attestSolverRefundFill(data: SolverRefundFillMessage["data"]) {
    const underpaymentBps = await this.getUnderpaymentBps(data);

    const orderHash = getOrderHash(data.order, await getSdkChainsConfig());

    // Verify the refunds
    for (
      let orderInputIndex = 0;
      orderInputIndex < data.order.inputs.length;
      orderInputIndex++
    ) {
      // Find the refund input corresponding to the current order input
      const dataInput = data.refunds.find(
        ({ inputIndex }) => inputIndex === orderInputIndex
      );
      if (!dataInput) {
        throw externalError(`Missing input ${orderInputIndex}`);
      }

      const refund =
        data.order.inputs[orderInputIndex].refunds[dataInput.refundIndex];
      if (!refund) {
        throw externalError(`Missing refund for input ${orderInputIndex}`);
      }

      const paidAmount = await this.getSolverPaidAmount(
        refund.chainId,
        dataInput.transactionId,
        {
          currency: refund.currency,
          recipient: refund.recipient,
          orderHash,
          extraData: refund.extraData,
          deadline: refund.deadline,
        }
      );

      // Ensure the paid amount matches the minimum amount requested by the user (adjusted for any underpayment)
      if (
        paidAmount <
        refund.minimumAmount -
          (refund.minimumAmount * underpaymentBps) / 10n ** 18n
      ) {
        throw externalError(
          `Insufficient amount for input refund payment ${orderInputIndex}`
        );
      }
    }
  }

  // Abstract methods (to be implemented by downstream classes)

  protected abstract getEscrowMessages(
    chainId: number,
    transactionId: string
  ): Promise<ProtocolMessage[]>;

  protected abstract getSolverPaidAmount(
    chainId: number,
    transactionId: string,
    payment: {
      currency: string;
      recipient: string;
      orderHash: string;
      extraData: string;
      deadline: number;
    }
  ): Promise<bigint>;

  // Private methods

  private async getUnderpaymentBps(data: {
    order: Order;
    orderSignature: string;
    inputs: {
      transactionId: string;
      inputIndex: number;
    }[];
  }) {
    // Ensure there's at most one input per chain id and currency
    {
      const chainIdAndCurrencySet = new Set<string>();
      for (const input of data.order.inputs) {
        const key =
          `${input.payment.chainId}:${input.payment.currency}`.toLowerCase();
        if (chainIdAndCurrencySet.has(key)) {
          throw externalError(
            "Order has multiple inputs for the same chain id and currency"
          );
        }

        chainIdAndCurrencySet.add(key);
      }
    }

    // Ensure there's a unique output payment per currency
    {
      const currencySet = new Set<string>();
      for (const payment of data.order.output.payments) {
        const key = `${payment.currency}`.toLowerCase();
        if (currencySet.has(key)) {
          throw externalError(
            "Order has multiple outputs for the same currency"
          );
        }

        currencySet.add(key);
      }
    }

    // Get the order hash
    const orderHash = getOrderHash(data.order, await getSdkChainsConfig());

    // Verify the order signature
    const isSignatureValid = await verifyMessage({
      address: data.order.solver as Address,
      message: {
        raw: orderHash,
      },
      signature: data.orderSignature as Hex,
    });
    if (!isSignatureValid) {
      throw externalError("Invalid order signature");
    }

    // Verify the inputs
    let totalWeightedPaidAmount = 0n;
    {
      const usedEscrowDepositOnchainIds = new Set<string>();
      for (
        let orderInputIndex = 0;
        orderInputIndex < data.order.inputs.length;
        orderInputIndex++
      ) {
        const orderInput = data.order.inputs[orderInputIndex];

        // Find the data input corresponding to the current order input
        const dataInput = data.inputs.find(
          ({ inputIndex }) => inputIndex === orderInputIndex
        );
        if (!dataInput) {
          throw externalError(`Missing input ${orderInputIndex}`);
        }

        // Get the escrow deposit corresponding to the current order input
        const escrowDeposit = await this.attestEscrowDeposits({
          chainId: orderInput.payment.chainId,
          transactionId: dataInput.transactionId,
        }).then((escrowDeposits) =>
          escrowDeposits.find(
            (d) =>
              d.result.depositId === orderHash &&
              d.result.currency.toLowerCase() ===
                orderInput.payment.currency.toLowerCase() &&
              !usedEscrowDepositOnchainIds.has(d.onchainId)
          )
        );
        if (!escrowDeposit) {
          throw externalError("Missing input payment");
        }

        // Mark the escrow deposit as used
        usedEscrowDepositOnchainIds.add(escrowDeposit.onchainId);

        // Keep track of the total weighted paid amount
        totalWeightedPaidAmount +=
          BigInt(escrowDeposit.result.amount) *
          BigInt(orderInput.payment.weight);
      }
    }

    // Compare the total weighted requested amount to the total weighted paid amount in order to determine any underpayment
    const totalWeightedRequestedAmount = data.order.inputs
      .map((input) => input.payment.amount * input.payment.weight)
      .reduce((a, b) => a + b, 0n);
    const underpaymentAmount =
      totalWeightedRequestedAmount - totalWeightedPaidAmount;
    const underpaymentBps =
      underpaymentAmount > 0n
        ? (underpaymentAmount * 10n ** 18n) / totalWeightedRequestedAmount
        : 0n;

    return underpaymentBps;
  }
}

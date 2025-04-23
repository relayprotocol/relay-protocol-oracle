import {
  EscrowDepositMessage,
  EscrowWithdrawalMessage,
  getOrderHash,
  Order,
  SolverFillMessage,
  SolverRefundMessage,
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

  public async attestSolverFill(
    data: SolverFillMessage["data"]
  ): Promise<SolverFillMessage> {
    const totalWeightedInputPaymentBpsDiff =
      await this.getTotalWeightedInputPaymentBpsDiff(data);

    const orderHash = getOrderHash(data.order, await getSdkChainsConfig());

    // Verify the fill
    for (
      let outputPaymentIndex = 0;
      outputPaymentIndex < data.order.output.payments.length;
      outputPaymentIndex++
    ) {
      const payment = data.order.output.payments[outputPaymentIndex];

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

      // Ensure the paid amount matches the minimum amount requested by the user (adjusted for any under/over-payment)
      if (
        paidAmount <
        BigInt(payment.minimumAmount) +
          (BigInt(payment.minimumAmount) * totalWeightedInputPaymentBpsDiff) /
            10n ** 18n
      ) {
        throw externalError(
          `Insufficient fill amount for order output payment ${outputPaymentIndex}`
        );
      }
    }

    if (data.order.output.calls.length) {
      // TODO: Ensure any output calls were executed
    }

    return {
      data,
      result: {
        validated: true,
        totalWeightedInputPaymentBpsDiff:
          totalWeightedInputPaymentBpsDiff.toString(),
      },
    };
  }

  public async attestSolverRefund(
    data: SolverRefundMessage["data"]
  ): Promise<SolverRefundMessage> {
    const totalWeightedInputPaymentBpsDiff =
      await this.getTotalWeightedInputPaymentBpsDiff(data);

    const orderHash = getOrderHash(data.order, await getSdkChainsConfig());

    // Verify the refunds
    for (
      let inputPaymentIndex = 0;
      inputPaymentIndex < data.order.inputs.length;
      inputPaymentIndex++
    ) {
      // Get the refund information corresponding to the current input payment
      const refundInformation = data.refunds.find(
        ({ inputIndex }) => inputIndex === inputPaymentIndex
      );
      if (!refundInformation) {
        throw externalError(
          `Missing refund information for order input payment ${inputPaymentIndex}`
        );
      }

      const orderRefund =
        data.order.inputs[inputPaymentIndex].refunds[
          refundInformation.refundIndex
        ];
      if (!orderRefund) {
        throw externalError(
          `Invalid refund information for order input payment ${inputPaymentIndex}`
        );
      }

      const paidAmount = await this.getSolverPaidAmount(
        orderRefund.chainId,
        refundInformation.transactionId,
        {
          currency: orderRefund.currency,
          recipient: orderRefund.recipient,
          orderHash,
          extraData: orderRefund.extraData,
          deadline: orderRefund.deadline,
        }
      );

      // Ensure the paid amount matches the minimum amount requested by the user (adjusted for any under/over-payment)
      if (
        paidAmount <
        BigInt(orderRefund.minimumAmount) +
          (BigInt(orderRefund.minimumAmount) *
            totalWeightedInputPaymentBpsDiff) /
            10n ** 18n
      ) {
        throw externalError(
          `Insufficient refund amount for order input payment ${inputPaymentIndex}`
        );
      }
    }

    return {
      data,
      result: {
        validated: true,
        totalWeightedInputPaymentBpsDiff:
          totalWeightedInputPaymentBpsDiff.toString(),
      },
    };
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

  private async getTotalWeightedInputPaymentBpsDiff(data: {
    order: Order;
    orderSignature: string;
    inputs: {
      transactionId: string;
      onchainId: string;
      inputIndex: number;
    }[];
  }) {
    // Ensure every input specifies a unique onchain id
    if (
      new Set(data.inputs.map((input) => input.onchainId)).size !==
      data.inputs.length
    ) {
      throw externalError("Input information contains non-unique onchain ids");
    }

    // Get the order hash
    const orderHash = getOrderHash(data.order, await getSdkChainsConfig());

    // Verify the order signature
    const isSignatureValid = await verifyMessage({
      address: data.order.solver.address as Address,
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
      for (
        let inputPaymentIndex = 0;
        inputPaymentIndex < data.order.inputs.length;
        inputPaymentIndex++
      ) {
        const orderInput = data.order.inputs[inputPaymentIndex];

        // Get the input information corresponding to the current input payment
        const inputInformation = data.inputs.find(
          ({ inputIndex }) => inputIndex === inputPaymentIndex
        );
        if (!inputInformation) {
          throw externalError(
            `Missing input information for order input payment ${inputPaymentIndex}`
          );
        }

        // Get the escrow deposit corresponding to the current order input payment
        const escrowDeposit = await this.attestEscrowDeposits({
          chainId: orderInput.payment.chainId,
          transactionId: inputInformation.transactionId,
        }).then((escrowDeposits) =>
          escrowDeposits.find((d) => d.onchainId === inputInformation.onchainId)
        );
        if (!escrowDeposit) {
          throw externalError(
            `Invalid input information for order input payment ${inputPaymentIndex}`
          );
        }

        // Keep track of the total weighted paid amount
        totalWeightedPaidAmount +=
          BigInt(escrowDeposit.result.amount) *
          BigInt(orderInput.payment.weight);
      }
    }

    // Compare the total weighted requested amount to the total weighted paid amount in order to determine any under/over-payment
    const totalWeightedRequestedAmount = data.order.inputs
      .map(
        (input) => BigInt(input.payment.amount) * BigInt(input.payment.weight)
      )
      .reduce((a, b) => a + b, 0n);
    const totalWeightedInputPaymentBpsDiff =
      ((totalWeightedPaidAmount - totalWeightedRequestedAmount) * 10n ** 18n) /
      totalWeightedRequestedAmount;

    return totalWeightedInputPaymentBpsDiff;
  }
}

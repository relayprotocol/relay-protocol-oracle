import { getOrderHash, Order } from "@reservoir0x/relay-protocol-sdk";

import { safeError } from "../../common/error";

export type EscrowDepositMessage = {
  kind: "escrow-deposit";
  messageId: string;
  input: {
    chainId: number;
    transactionId: string;
  };
  output: {
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
  input: {
    chainId: number;
    transactionId: string;
  };
  output: {
    id?: string;
    escrow: string;
    currency: string;
    amount: string;
  };
};

export type SolverFillMessage = {
  kind: "solver-fill";
  messageId: string;
  input: {
    order: Order;
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
  output: {
    valid: boolean;
  };
};

export type AttestationMessage = EscrowDepositMessage | EscrowWithdrawalMessage;

export abstract class AttestationService {
  protected abstract getEscrowMessages(
    chainId: number,
    transactionId: string
  ): Promise<AttestationMessage[]>;

  protected abstract getSolverPaidAmount(data: {
    chainId: number;
    transactionId: string;
    currency: string;
    recipient: string;
    orderHash: string;
    extraData: string;
    deadline: number;
  }): Promise<bigint>;

  public async attestEscrowDeposits(
    data: EscrowDepositMessage["input"]
  ): Promise<EscrowDepositMessage[]> {
    return this.getEscrowMessages(data.chainId, data.transactionId).then(
      (messages) => messages.filter((m) => m.kind === "escrow-deposit")
    );
  }

  public async attestEscrowWithdrawals(
    data: EscrowWithdrawalMessage["input"]
  ): Promise<EscrowWithdrawalMessage[]> {
    return this.getEscrowMessages(data.chainId, data.transactionId).then(
      (messages) => messages.filter((m) => m.kind === "escrow-withdrawal")
    );
  }

  public async attestSolverFill(data: SolverFillMessage["input"]) {
    // TODO: Verify order signature
    // TODO: Verify there's at most one input per chain id and currency
    // TODO: Verify the output doesn't include the same currency more than once

    // Get the order hash
    const orderHash = getOrderHash(data.order);

    // Verify the inputs
    let totalWeightedPaidAmount = 0n;
    {
      const usedEscrowDepositMessageIds = new Set<string>();
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
          throw safeError("Missing input");
        }

        // Get the escrow deposit corresponding to the current order input
        const escrowDeposit = await this.attestEscrowDeposits({
          chainId: orderInput.chainId,
          transactionId: dataInput.transactionId,
        }).then((escrowDeposits) =>
          escrowDeposits.find(
            (d) =>
              d.output.id === orderHash &&
              d.output.currency.toLowerCase() ===
                orderInput.payment.currency.toLowerCase() &&
              usedEscrowDepositMessageIds.has(d.messageId)
          )
        );
        if (!escrowDeposit) {
          throw safeError("Missing input payment");
        }

        // Mark the escrow deposit as used
        usedEscrowDepositMessageIds.add(escrowDeposit.messageId);

        // Keep track of the total weighted paid amount
        totalWeightedPaidAmount +=
          BigInt(escrowDeposit.output.amount) *
          BigInt(orderInput.payment.weight);
      }
    }

    // Compare the total weighted requested amount to the paid amount in order to determine any underpayment
    const totalWeightedRequestedAmount = data.order.inputs
      .map((input) => input.payment.amount * input.payment.weight)
      .reduce((a, b) => a + b, 0n);
    const underpaymentAmount =
      totalWeightedRequestedAmount - totalWeightedPaidAmount;
    const underpaymentBps =
      underpaymentAmount > 0n
        ? (underpaymentAmount * 10n ** 18n) / totalWeightedRequestedAmount
        : 0n;

    // Verify the output
    switch (data.output.status) {
      case "success": {
        for (
          let paymentIndex = 0;
          paymentIndex < data.order.output.payments.length;
          paymentIndex++
        ) {
          const payment = data.order.output.payments[paymentIndex];

          const paidAmount = await this.getSolverPaidAmount({
            chainId: data.order.output.chainId,
            transactionId: data.output.fill.transactionId,
            currency: payment.currency,
            recipient: payment.to,
            orderHash,
            extraData: data.order.output.extraData,
            deadline: data.order.output.deadline,
          });

          // Ensure the payment matches the minimum amount requested by the user
          if (
            paidAmount <
            payment.minimumAmount -
              (payment.minimumAmount * underpaymentBps) / 10n ** 18n
          ) {
            throw safeError(
              `Insufficient refund amount for output payment ${paymentIndex}`
            );
          }
        }

        if (data.order.output.calls.length) {
          // TODO: Ensure any output calls were executed
        }

        break;
      }

      case "refund": {
        for (
          let orderInputIndex = 0;
          orderInputIndex < data.order.inputs.length;
          orderInputIndex++
        ) {
          // Find the refund input corresponding to the current order input
          const dataInput = data.output.refunds.find(
            ({ inputIndex }) => inputIndex === orderInputIndex
          );
          if (!dataInput) {
            throw safeError(`Missing input ${orderInputIndex}`);
          }

          const refund =
            data.order.inputs[orderInputIndex].refunds[dataInput.refundIndex];
          if (!refund) {
            throw safeError(`Missing refund for input ${orderInputIndex}`);
          }

          const paidAmount = await this.getSolverPaidAmount({
            chainId: refund.chainId,
            transactionId: dataInput.transactionId,
            currency: refund.currency,
            recipient: refund.to,
            orderHash,
            extraData: refund.extraData,
            deadline: refund.deadline,
          });

          // Ensure the payment matches the minimum amount requested by the user
          if (
            paidAmount <
            refund.minimumAmount -
              (refund.minimumAmount * underpaymentBps) / 10n ** 18n
          ) {
            throw safeError(
              `Insufficient refund amount for input ${orderInputIndex}`
            );
          }
        }

        break;
      }
    }
  }
}

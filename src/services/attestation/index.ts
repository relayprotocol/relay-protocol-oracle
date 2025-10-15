import {
  ActionType,
  DepositoryDepositMessage,
  DepositoryWithdrawalMessage,
  DepositoryWithdrawalStatus,
  encodeAction,
  ExecutionMessage,
  getOrderId,
  Order,
  SolverFillMessage,
  SolverFillStatus,
  SolverRefundMessage,
  SolverRefundStatus,
} from "@reservoir0x/relay-protocol-sdk";
import { generateTokenId, generateAddress } from "@relay-protocol/hub-utils";
import {
  Address,
  encodePacked,
  Hex,
  keccak256,
  maxUint256,
  verifyMessage,
  zeroHash,
} from "viem";

import { getVmAttestor } from "./vm";
import { EnhancedDepositoryDepositMessage } from "./vm/types";
import { getDeterministicId } from "./vm/utils";
import {
  getChainHubChainId,
  getChainVmType,
  getSdkChainsConfig,
  HUB_CHAIN_ID,
  HUB_VM_TYPE
} from "../../common/chains";
import { externalError } from "../../common/error";

export class AttestationService {
  public async attestDepositoryDeposits(
    data: DepositoryDepositMessage["data"] & {
      includeOnchainHubExecution?: boolean;
    }
  ): Promise<{
    messages: DepositoryDepositMessage[];
    execution?: ExecutionMessage;
  }> {
    const messages = await getVmAttestor(data.chainId).then((attestor) =>
      attestor.getDepositoryDepositMessages(data.chainId, data.transactionId)
    );

    // Generate onchain hub execution
    let execution: ExecutionMessage | undefined;
    if (data.includeOnchainHubExecution) {
      execution = !messages.length
        ? undefined
        : {
            idempotencyKey: getDeterministicId(
              data.chainId,
              data.transactionId
            ),
            actions: await Promise.all(
              messages.map(async (m) => {

                const hubTokenId = generateTokenId({
                  address: m.result.currency,
                  chainId: await getChainHubChainId(m.data.chainId),
                  family: await getChainVmType(m.data.chainId),
                })

                const hubToAddress = m.result.depositId !== zeroHash ? 
                // This order lives only on the hub
                // so we do not need to hash it
                  await this._getOrderAddress({
                    chainId: m.data.chainId,
                    timestamp: m.extraData.timestamp,
                    depositor: m.result.depositor,
                    depositId: m.result.depositId,
                  }) 
                  : 
                  // in case no deposit info is attached, use the depositor alias on the hub 
                  generateAddress({
                    address: m.result.depositor,
                    chainId: HUB_CHAIN_ID,
                    family: HUB_VM_TYPE,
                  })
                
                const amount = m.result.amount;

                const results = [
                  encodeAction({
                    type: ActionType.MINT,
                    data: {
                      hubTokenId,
                      hubToAddress,
                      amount,
                    },
                  }),
                ];
                return results;
              })
            ).then((r) => r.flat()),
          };
    }

    return {
      messages,
      execution,
    };
  }

  public async attestDepositoryWithdrawal(
    data: DepositoryWithdrawalMessage["data"] & {
      includeOnchainHubExecution?: boolean;
    }
  ): Promise<{
    message: DepositoryWithdrawalMessage;
    execution?: ExecutionMessage;
  }> {
    const message = await getVmAttestor(data.chainId).then((attestor) =>
      attestor.getDepositoryWithdrawalMessage(data.chainId, data.withdrawal)
    );

    // Generate onchain hub execution
    let execution: ExecutionMessage | undefined;
    if (data.includeOnchainHubExecution) {
      if (message.result.status === DepositoryWithdrawalStatus.EXECUTED) {
        // TODO: Burn from withdrawal
      } else if (message.result.status === DepositoryWithdrawalStatus.EXPIRED) {
        // TODO: Transfer from withdrawal to depositor
      }
    }

    return {
      message,
      execution,
    };
  }

  public async attestSolverFill(
    data: SolverFillMessage["data"] & {
      force?: boolean;
      includeOnchainHubExecution?: boolean;
    }
  ): Promise<{ message: SolverFillMessage; execution?: ExecutionMessage }> {
    if (data.force) {
      // TODO: Return execution for forced attestations
      return {
        message: {
          data,
          result: {
            orderId: getOrderId(data.order, await getSdkChainsConfig()),
            status: SolverFillStatus.SUCCESSFUL,
            totalWeightedInputPaymentBpsDiff: "0",
          },
        },
      };
    }

    const { totalWeightedInputPaymentBpsDiff, depositoryDeposits } =
      await this._getDepositsDetails(data);

    const orderId = getOrderId(data.order, await getSdkChainsConfig());

    // Verify the fill
    for (
      let outputPaymentIndex = 0;
      outputPaymentIndex < data.order.output.payments.length;
      outputPaymentIndex++
    ) {
      const payment = data.order.output.payments[outputPaymentIndex];

      const attestor = await getVmAttestor(data.order.output.chainId);
      const paidAmount = await attestor.getSolverPaidAmount(
        data.order.output.chainId,
        data.fill.transactionId,
        {
          currency: payment.currency,
          recipient: payment.recipient,
          orderId,
          extraData: data.order.output.extraData,
          deadline: data.order.output.deadline,
        }
      );

      // Ensure the paid amount matches the minimum amount requested by the user (adjusted for any under/over-payment)
      const minimumAmount =
        BigInt(payment.minimumAmount) +
        (BigInt(payment.minimumAmount) * totalWeightedInputPaymentBpsDiff) /
          10n ** 18n;
      if (paidAmount < minimumAmount) {
        throw externalError(
          `Insufficient fill amount for order output payment ${outputPaymentIndex} (paidAmount=${paidAmount}, minimumAmount=${minimumAmount})`
        );
      }
    }

    // Verify any calls to be executed
    if (data.order.output.calls.length) {
      const attestor = await getVmAttestor(data.order.output.chainId);
      if (
        !(await attestor.verifySolverCalls(
          data.order.output.chainId,
          data.fill.transactionId,
          data.order.output.calls,
          data.order.output.extraData
        ))
      ) {
        throw externalError(`Missing call executions`);
      }
    }

    return {
      message: {
        data,
        result: {
          orderId: getOrderId(data.order, await getSdkChainsConfig()),
          status: SolverFillStatus.SUCCESSFUL,
          totalWeightedInputPaymentBpsDiff:
            totalWeightedInputPaymentBpsDiff.toString(),
        },
      },
      execution: data.includeOnchainHubExecution
        ? await this._getSolverFillOrRefundExecution({
            order: data.order,
            totalWeightedInputPaymentBpsDiff,
            depositoryDeposits,
            type: "fill",
          })
        : undefined,
    };
  }

  public async attestSolverRefund(
    data: SolverRefundMessage["data"] & {
      force?: boolean;
      includeOnchainHubExecution?: boolean;
    }
  ): Promise<{ message: SolverRefundMessage; execution?: ExecutionMessage }> {
    if (data.force) {
      // TODO: Return execution for forced attestations
      return {
        message: {
          data,
          result: {
            orderId: getOrderId(data.order, await getSdkChainsConfig()),
            status: SolverRefundStatus.SUCCESSFUL,
            totalWeightedInputPaymentBpsDiff: "0",
          },
        },
      };
    }

    const { totalWeightedInputPaymentBpsDiff, depositoryDeposits } =
      await this._getDepositsDetails(data);

    const orderId = getOrderId(data.order, await getSdkChainsConfig());

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

      const paidAmount = await getVmAttestor(orderRefund.chainId).then(
        (attestor) =>
          attestor.getSolverPaidAmount(
            orderRefund.chainId,
            refundInformation.transactionId,
            {
              currency: orderRefund.currency,
              recipient: orderRefund.recipient,
              orderId,
              extraData: orderRefund.extraData,
              deadline: orderRefund.deadline,
            }
          )
      );

      // Ensure the paid amount matches the minimum amount requested by the user (adjusted for any under/over-payment)
      const minimumAmount =
        BigInt(orderRefund.minimumAmount) +
        (BigInt(orderRefund.minimumAmount) * totalWeightedInputPaymentBpsDiff) /
          10n ** 18n;
      if (paidAmount < minimumAmount) {
        throw externalError(
          `Insufficient refund amount for order input payment ${inputPaymentIndex} (paidAmount=${paidAmount}, minimumAmount=${minimumAmount})`
        );
      }
    }

    return {
      message: {
        data,
        result: {
          orderId: getOrderId(data.order, await getSdkChainsConfig()),
          status: SolverRefundStatus.SUCCESSFUL,
          totalWeightedInputPaymentBpsDiff:
            totalWeightedInputPaymentBpsDiff.toString(),
        },
      },
      execution: data.includeOnchainHubExecution
        ? await this._getSolverFillOrRefundExecution({
            order: data.order,
            totalWeightedInputPaymentBpsDiff,
            depositoryDeposits,
            type: "refund",
          })
        : undefined,
    };
  }

  private async _getDepositsDetails(data: {
    order: Order;
    orderSignature: string;
    inputs: {
      transactionId: string;
      onchainId: string;
      inputIndex: number;
    }[];
  }): Promise<{
    totalWeightedInputPaymentBpsDiff: bigint;
    depositoryDeposits: EnhancedDepositoryDepositMessage[];
  }> {
    // Ensure every input specifies a unique onchain id
    if (
      new Set(data.inputs.map((input) => input.onchainId)).size !==
      data.inputs.length
    ) {
      throw externalError("Input information contains non-unique onchain ids");
    }

    // Get the order id
    const orderId = getOrderId(data.order, await getSdkChainsConfig());

    // Verify the order signature
    const isSignatureValid = await verifyMessage({
      address: data.order.solver as Address,
      message: {
        raw: orderId,
      },
      signature: data.orderSignature as Hex,
    }).catch(() => false);
    if (!isSignatureValid) {
      throw externalError("Invalid order signature");
    }

    // Verify the inputs
    let totalWeightedPaidAmount = 0n;
    const depositoryDeposits: EnhancedDepositoryDepositMessage[] = [];
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

        // Get the depository deposit corresponding to the current order input payment
        const depositoryDeposit = await getVmAttestor(
          orderInput.payment.chainId
        )
          .then((attestor) =>
            attestor.getDepositoryDepositMessages(
              orderInput.payment.chainId,
              inputInformation.transactionId
            )
          )
          .then((depositoryDeposits) =>
            depositoryDeposits.find(
              (d) =>
                d.result.depositId === orderId &&
                d.result.onchainId === inputInformation.onchainId
            )
          );
        if (!depositoryDeposit) {
          throw externalError(
            `Invalid input information for order input payment ${inputPaymentIndex}`
          );
        }

        // Keep track of the total weighted paid amount
        totalWeightedPaidAmount +=
          BigInt(depositoryDeposit.result.amount) *
          BigInt(orderInput.payment.weight);

        // Save the corresponding deposit
        depositoryDeposits.push(depositoryDeposit);
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

    return {
      totalWeightedInputPaymentBpsDiff,
      depositoryDeposits,
    };
  }

  private async _getOrderAddress(data: {
    chainId: string;
    timestamp: string;
    depositor: string;
    depositId: string;
  }): Promise<string> {
    return keccak256(
      encodePacked(
        ["string", "uint256", "uint256", "string", "bytes32"],
        [
          await getChainVmType(data.chainId),
          BigInt(await getChainHubChainId(data.chainId)),
          BigInt(data.timestamp),
          data.depositor,
          data.depositId as Hex,
        ]
      )
    );
  }

  private async _getSolverFillOrRefundExecution(data: {
    order: Order;
    totalWeightedInputPaymentBpsDiff: bigint;
    depositoryDeposits: EnhancedDepositoryDepositMessage[];
    type: "fill" | "refund";
  }): Promise<ExecutionMessage> {
    const actions: string[] = [];

    // Transfer from order to solver
    for (const deposit of data.depositoryDeposits) {

      const hubTokenId = generateTokenId({
        address: deposit.result.currency,
        chainId: await getChainHubChainId(deposit.data.chainId),
        family: await getChainVmType(deposit.data.chainId),
      })

      const hubFromAddress = await this._getOrderAddress({
        chainId: deposit.data.chainId,
        timestamp: deposit.extraData.timestamp,
        depositor: deposit.result.depositor,
        depositId: deposit.result.depositId,
      })

      // solver address on the hub
      const hubToAddress = generateAddress({
        address: data.order.solver,
        chainId: await getChainHubChainId(data.order.solverChainId),
        family: await getChainVmType(data.order.solverChainId),
      })
      
      const amount = deposit.result.amount;

      actions.push(
        encodeAction({
          type: ActionType.TRANSFER,
          data: {
            hubTokenId,
            hubFromAddress,
            hubToAddress,
            amount,
          },
        })
      );
    }

    // Only when the solver filled, transfer from solver to fee recipients
    if (data.type === "fill") {
      for (const fee of data.order.fees) {

        const hubTokenId = generateTokenId({
          address: fee.currency,
          chainId: await getChainHubChainId(fee.currencyChainId),
          family: await getChainVmType(fee.currencyChainId),
        })

        // solver address on the hub
        const hubFromAddress = generateAddress({
          address: data.order.solver,
          chainId: await getChainHubChainId(data.order.solverChainId),
          family: await getChainVmType(data.order.solverChainId),
        })

        const hubToAddress = generateAddress({
          address: fee.recipient,
          chainId: await getChainHubChainId(fee.recipientChainId),
          family: await getChainVmType(fee.recipientChainId),
        })

        const amount = String(
          BigInt(fee.amount) +
            (BigInt(fee.amount) *
              BigInt(data.totalWeightedInputPaymentBpsDiff)) /
              10n ** 18n
        )
        actions.push(
          encodeAction({
            type: ActionType.TRANSFER,
            data: {
              hubTokenId,
              hubFromAddress,
              hubToAddress,
              amount,
            },
          }),
        );
      }
    }

    return {
      idempotencyKey: getOrderId(data.order, await getSdkChainsConfig()),
      actions,
    };
  }
}

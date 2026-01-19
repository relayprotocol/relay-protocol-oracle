import {
  ActionType,
  decodeWithdrawal,
  DepositoryDepositMessage,
  DepositoryWithdrawalMessage,
  DepositoryWithdrawalStatus,
  encodeAction,
  ExecutionMessage,
  getDecodedWithdrawalAmount,
  getOrderId,
  Order,
  SolverFillMessage,
  SolverFillStatus,
  SolverRefundMessage,
  SolverRefundStatus,
  WithdrawalInitiationMessage,
  WithdrawalInitiatedMessage,
  getWithdrawalAddress,
  ExecutionMessageMetadata,
  WithdrawalAddressRequest,
  getVmTypeNativeCurrency,
  generateTokenId,
  generateAddress,
  computeWithdrawerBalanceMessage,
} from "@relay-protocol/settlement-sdk";

import {
  Address,
  encodePacked,
  Hex,
  keccak256,
  verifyMessage,
  zeroHash,
} from "viem";

import { getVmAttestor, getHubAttestor } from "./vm";
import { EnhancedDepositoryDepositMessage } from "./vm/types";
import { getDeterministicId } from "./vm/utils";
import {
  getChain,
  getChainHubChainId,
  getChainVmType,
  getHubChains,
  getSdkChainsConfig,
} from "../../common/chains";
import { externalError } from "../../common/error";
import { createHash } from "crypto";

type ExecutionMetadata = Omit<
  ExecutionMessageMetadata,
  "oracleContract" | "oracleChainId"
>;

export type TxHints = {
  "hyperliquid-vm"?: {
    user: string;
    timestamp: number;
  };
};

export class AttestationService {
  public async attestDepositoryDeposits(
    data: DepositoryDepositMessage["data"],
  ): Promise<{
    messages: DepositoryDepositMessage[];
    execution?: ExecutionMessage;
  }> {
    const attestor = await getVmAttestor(data.chainId);
    const messages = await attestor.getDepositoryDepositMessages(
      data.chainId,
      data.transactionId,
    );

    // Generate Hub execution
    let execution: ExecutionMessage | undefined;
    if (messages.length) {
      const actions: string[] = [];
      const metadata: ExecutionMetadata[] = [];

      await Promise.all(
        messages.map(async (m) => {
          const origin = {
            address: m.result.currency,
            chainId: await getChainHubChainId(m.data.chainId),
            family: await getChainVmType(m.data.chainId),
          };

          const hubTokenId = generateTokenId(origin);
          metadata.push({
            hubTokenId,
            origin,
            chainId: m.data.chainId,
          });

          const hubToAddress =
            m.result.depositId !== zeroHash
              ? await this._getOrderAddress({
                  chainId: m.data.chainId,
                  timestamp: m.extraData.timestamp,
                  depositor: m.result.depositor,
                  depositId: m.result.depositId,
                })
              : // In case no deposit id is attached, use the depositor alias on the hub
                generateAddress({
                  address: m.result.depositor,
                  chainId: await getChainHubChainId(m.data.chainId),
                  family: await getChainVmType(m.data.chainId),
                });

          const amount = m.result.amount;
          actions.push(
            encodeAction({
              type: ActionType.MINT,
              data: {
                hubTokenId,
                hubToAddress,
                amount,
              },
            }),
          );
        }),
      );

      // Parse metadata for all oracle chains
      const metadataForAllOracles: ExecutionMessageMetadata[] = [];
      const hubChains = await getHubChains();
      if (hubChains) {
        Object.values(hubChains).map((chain) => {
          const metadataWithOracleInfo = metadata.map((md) => ({
            ...md,
            oracleChainId: chain.hubChainId || "",
            oracleContract: chain.additionalData.oracleAddress as `0x${string}`,
          }));
          metadataForAllOracles.push(...metadataWithOracleInfo);
        });
      }

      execution = {
        idempotencyKey: getDeterministicId(data.chainId, data.transactionId),
        actions,
        metadata: metadataForAllOracles,
      };
    }

    return {
      messages,
      execution,
    };
  }

  public async attestWithdrawerBalance(
    data: WithdrawalInitiationMessage["data"],
  ): Promise<{
    message: WithdrawalInitiationMessage;
    execution?: ExecutionMessage;
  }> {
    const { hubTokenId, withdrawalAddress, withdrawerAlias } =
      await this._getWithdrawalAddress(data);

    // recompute hash data
    const signedMessage = computeWithdrawerBalanceMessage(
      withdrawerAlias,
      BigInt(data.expectedAmount),
      data.withdrawalNonce,
    );
    const hash = createHash("sha256").update(signedMessage).digest("hex");

    // only EVM sig supported atm
    const signatureVmType = await getChainVmType(data.withdrawerChainId);
    if (signatureVmType !== "ethereum-vm") {
      throw externalError("Only 'ethereum-vm' signatures are supported");
    }

    // validate withdrawer address from signature
    const isSignatureValid = await verifyMessage({
      address: data.withdrawer as Address,
      message: {
        raw: `0x${hash}`,
      },
      signature: data.signature as Hex,
    });

    if (!isSignatureValid) {
      throw externalError("Invalid signature. Can't trigger withdrawal");
    }

    // check balance on the hub
    const balance = await getHubAttestor().then((attestor) =>
      attestor.getBalanceOnHub(
        data.settlementChainId,
        withdrawerAlias,
        hubTokenId,
      ),
    );

    if (!balance || BigInt(balance) < BigInt(data.expectedAmount)) {
      throw externalError("Insufficient initial withdrawal balance");
    }

    const execution = {
      idempotencyKey: getDeterministicId(
        data.settlementChainId,
        hubTokenId.toString(),
        withdrawalAddress,
      ),
      actions: [
        encodeAction({
          type: ActionType.TRANSFER,
          data: {
            hubTokenId: hubTokenId,
            hubFromAddress: withdrawerAlias,
            hubToAddress: withdrawalAddress,
            amount: data.expectedAmount,
          },
        }),
      ],
    };

    return {
      message: {
        data,
        result: {
          withdrawalAddress,
        },
      },
      execution,
    };
  }

  public async attestWithdrawalAddressBalance(
    data: WithdrawalInitiatedMessage["data"],
  ): Promise<{
    message: WithdrawalInitiatedMessage;
  }> {
    const { hubTokenId, withdrawalAddress } =
      await this._getWithdrawalAddress(data);

    const balance = await getHubAttestor().then((attestor) =>
      attestor.getBalanceOnHub(
        data.settlementChainId,
        withdrawalAddress,
        hubTokenId,
      ),
    );

    if (!balance || BigInt(balance) < BigInt(data.expectedAmount)) {
      throw externalError("Insufficient withdrawal address balance");
    }

    const proofOfWithdrawalAddressBalance =
      await this._getProofOfWithdrawalAddressBalance({
        withdrawalNonce: data.withdrawalNonce,
        withdrawalAddress,
        amount: BigInt(data.expectedAmount),
      });

    return {
      message: {
        data,
        result: {
          proofOfWithdrawalAddressBalance,
          withdrawalAddress,
        },
      },
    };
  }

  public async attestDepositoryWithdrawal(
    data: DepositoryWithdrawalMessage["data"] & {
      transactionId?: string;
      withdrawalAddressRequest?: WithdrawalAddressRequest;
    },
  ): Promise<{
    message: DepositoryWithdrawalMessage;
    execution?: ExecutionMessage;
  }> {
    const message = await getVmAttestor(data.chainId).then((attestor) =>
      attestor.getDepositoryWithdrawalMessage(
        data.chainId,
        data.withdrawal,
        data.transactionId,
      ),
    );

    // Generate onchain hub execution
    let execution: ExecutionMessage | undefined;
    if (data.withdrawalAddressRequest) {
      const { withdrawalAddress, hubTokenId, withdrawerAlias } =
        await this._getWithdrawalAddress(data.withdrawalAddressRequest);

      const decodedWithdrawal = decodeWithdrawal(
        data.withdrawal,
        await getChainVmType(data.chainId),
      );
      const amount = getDecodedWithdrawalAmount(decodedWithdrawal);

      if (message.result.status === DepositoryWithdrawalStatus.EXECUTED) {
        // Burn the funds from withdrawal address
        execution = {
          idempotencyKey: getDeterministicId(
            message.result.withdrawalId,
            data.transactionId!,
          ),
          actions: [
            encodeAction({
              type: ActionType.BURN,
              data: {
                hubTokenId,
                hubFromAddress: withdrawalAddress,
                amount,
              },
            }),
          ],
        };
      } else if (message.result.status === DepositoryWithdrawalStatus.EXPIRED) {
        // Transfer back the funds from withdrawal address to depositor
        execution = {
          idempotencyKey: getDeterministicId(
            message.result.withdrawalId,
            data.transactionId!,
            DepositoryWithdrawalStatus.EXPIRED.toString(),
          ),
          actions: [
            encodeAction({
              type: ActionType.TRANSFER,
              data: {
                hubTokenId,
                hubFromAddress: withdrawalAddress,
                hubToAddress: withdrawerAlias,
                amount,
              },
            }),
          ],
        };
      }
    }

    return {
      message,
      execution,
    };
  }

  public async attestSolverFill(
    data: SolverFillMessage["data"] & { hints?: TxHints } & {
      force?: boolean;
    },
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
        },
        data.hints,
      );

      // Ensure the paid amount matches the minimum amount requested by the user (adjusted for any under/over-payment)
      const minimumAmount =
        BigInt(payment.minimumAmount) +
        (BigInt(payment.minimumAmount) * totalWeightedInputPaymentBpsDiff) /
          10n ** 18n;
      if (paidAmount < minimumAmount) {
        throw externalError(
          `Insufficient fill amount for order output payment ${outputPaymentIndex} (paidAmount=${paidAmount}, minimumAmount=${minimumAmount})`,
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
          data.order.output.extraData,
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
      execution: await this._getSolverFillOrRefundExecution({
        order: data.order,
        totalWeightedInputPaymentBpsDiff,
        depositoryDeposits,
        type: "fill",
      }),
    };
  }

  public async attestSolverRefund(
    data: SolverRefundMessage["data"] & { hints?: TxHints } & {
      force?: boolean;
    },
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
        ({ inputIndex }) => inputIndex === inputPaymentIndex,
      );
      if (!refundInformation) {
        throw externalError(
          `Missing refund information for order input payment ${inputPaymentIndex}`,
        );
      }

      const orderRefund =
        data.order.inputs[inputPaymentIndex].refunds[
          refundInformation.refundIndex
        ];
      if (!orderRefund) {
        throw externalError(
          `Invalid refund information for order input payment ${inputPaymentIndex}`,
        );
      }

      const paidAmount = await getVmAttestor(orderRefund.chainId).then(
        async (attestor) =>
          attestor.getSolverPaidAmount(
            orderRefund.chainId,
            refundInformation.transactionId,
            {
              currency: orderRefund.currency,
              // If the refund recipient matches the address of the native currency on the chain, refund to the depositor
              recipient:
                orderRefund.recipient ===
                getVmTypeNativeCurrency(
                  await getChainVmType(orderRefund.chainId),
                )
                  ? depositoryDeposits[inputPaymentIndex].result.depositor
                  : orderRefund.recipient,
              orderId,
              extraData: orderRefund.extraData,
              deadline: orderRefund.deadline,
            },
            data.hints,
          ),
      );

      // Ensure the paid amount matches the minimum amount requested by the user (adjusted for any under/over-payment)
      const minimumAmount =
        BigInt(orderRefund.minimumAmount) +
        (BigInt(orderRefund.minimumAmount) * totalWeightedInputPaymentBpsDiff) /
          10n ** 18n;
      if (paidAmount < minimumAmount) {
        throw externalError(
          `Insufficient refund amount for order input payment ${inputPaymentIndex} (paidAmount=${paidAmount}, minimumAmount=${minimumAmount})`,
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
      execution: await this._getSolverFillOrRefundExecution({
        order: data.order,
        totalWeightedInputPaymentBpsDiff,
        depositoryDeposits,
        type: "refund",
      }),
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
          ({ inputIndex }) => inputIndex === inputPaymentIndex,
        );
        if (!inputInformation) {
          throw externalError(
            `Missing input information for order input payment ${inputPaymentIndex}`,
          );
        }

        // Get the depository deposit corresponding to the current order input payment
        const fetchedDeposits = await getVmAttestor(
          orderInput.payment.chainId,
        ).then((attestor) =>
          attestor.getDepositoryDepositMessages(
            orderInput.payment.chainId,
            inputInformation.transactionId,
          ),
        );
        const depositoryDeposit = fetchedDeposits.find(
          (d) =>
            d.result.depositId === orderId &&
            d.result.onchainId === inputInformation.onchainId,
        );
        if (!depositoryDeposit) {
          throw externalError(
            `Invalid input information for order input payment ${inputPaymentIndex} (orderId=${orderId} onchainId=${
              inputInformation.onchainId
            } depositoryDeposits=${JSON.stringify(fetchedDeposits)})`,
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
        (input) => BigInt(input.payment.amount) * BigInt(input.payment.weight),
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
    const orderHash = keccak256(
      encodePacked(
        ["string", "uint256", "uint256", "string", "bytes32"],
        [
          await getChainVmType(data.chainId),
          BigInt(await getChainHubChainId(data.chainId)),
          BigInt(data.timestamp),
          data.depositor,
          data.depositId as Hex,
        ],
      ),
    );

    const orderAddress = orderHash.slice(2).slice(-40);
    return `0x${orderAddress}` as `0x${string}`;
  }

  private async _getSolverFillOrRefundExecution(data: {
    order: Order;
    totalWeightedInputPaymentBpsDiff: bigint;
    depositoryDeposits: EnhancedDepositoryDepositMessage[];
    type: "fill" | "refund";
  }): Promise<ExecutionMessage> {
    const actions: string[] = [];

    // Solver address on the hub
    const solverAlias = generateAddress({
      address: data.order.solver,
      chainId: await getChainHubChainId(data.order.solverChainId),
      family: await getChainVmType(data.order.solverChainId),
    });

    // Transfer from order to solver
    for (const deposit of data.depositoryDeposits) {
      const hubTokenId = generateTokenId({
        address: deposit.result.currency,
        chainId: await getChainHubChainId(deposit.data.chainId),
        family: await getChainVmType(deposit.data.chainId),
      });

      const hubFromAddress = await this._getOrderAddress({
        chainId: deposit.data.chainId,
        timestamp: deposit.extraData.timestamp,
        depositor: deposit.result.depositor,
        depositId: deposit.result.depositId,
      });

      const amount = deposit.result.amount;

      actions.push(
        encodeAction({
          type: ActionType.TRANSFER,
          data: {
            hubTokenId,
            hubFromAddress,
            hubToAddress: solverAlias,
            amount,
          },
        }),
      );
    }

    // Only when the solver filled, transfer from solver to fee recipients
    if (data.type === "fill") {
      for (const fee of data.order.fees) {
        const hubTokenId = generateTokenId({
          address: fee.currency,
          chainId: await getChainHubChainId(fee.currencyChainId),
          family: await getChainVmType(fee.currencyChainId),
        });

        const hubToAddress = generateAddress({
          address: fee.recipient,
          chainId: await getChainHubChainId(fee.recipientChainId),
          family: await getChainVmType(fee.recipientChainId),
        });

        const amount = String(
          BigInt(fee.amount) +
            (BigInt(fee.amount) *
              BigInt(data.totalWeightedInputPaymentBpsDiff)) /
              10n ** 18n,
        );
        actions.push(
          encodeAction({
            type: ActionType.TRANSFER,
            data: {
              hubTokenId,
              hubFromAddress: solverAlias,
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

  private async _getDepositoryAddress(chainId: string) {
    const chain = await getChain(chainId);
    const depositoryAddress = chain.depository;
    if (!depositoryAddress) {
      throw externalError("Chain has no depository configured");
    }
    return depositoryAddress;
  }

  private async _getWithdrawalAddress(data: WithdrawalAddressRequest) {
    const depositoryAddress = await this._getDepositoryAddress(data.chainId);

    // the token to be withdrawn from depository
    const hubTokenId = generateTokenId({
      address: data.currency,
      chainId: await getChainHubChainId(data.chainId),
      family: await getChainVmType(data.chainId),
    });

    // the alias for withdrawer address on origin chain
    const withdrawerAlias = generateAddress({
      address: data.withdrawer,
      chainId: await getChainHubChainId(data.withdrawerChainId),
      family: await getChainVmType(data.withdrawerChainId),
    });

    // compute address
    const withdrawalAddress = getWithdrawalAddress({
      depository: depositoryAddress,
      depositoryChainId: await getChainHubChainId(data.chainId),
      recipient: data.recipient, // on destination chain
      currency: data.currency,
      withdrawerAlias,
      withdrawalNonce: data.withdrawalNonce,
    });

    return {
      hubTokenId,
      withdrawalAddress,
      withdrawerAlias,
    };
  }

  private async _getProofOfWithdrawalAddressBalance(data: {
    amount: bigint;
    withdrawalAddress: string;
    withdrawalNonce: string;
  }): Promise<string> {
    const proof = encodePacked(
      ["address", "uint256", "bytes32"],
      [
        data.withdrawalAddress as `0x${string}`,
        data.amount,
        data.withdrawalNonce as `0x${string}`,
      ],
    );
    return proof;
  }
}

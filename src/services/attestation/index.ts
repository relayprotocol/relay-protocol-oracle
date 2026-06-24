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
  getOrderAddress,
  ExecutionMessageMetadata,
  getVmTypeNativeCurrency,
  generateTokenId,
  generateAddress,
  DenormalizedSubmitWithdrawRequest,
  getWithdrawalAddress,
  normalizePayloadParams,
  SubmitWithdrawRequest,
  GenericMappingMessage,
  getNoFillOrRefundMessage,
  getNonceMappingMessage,
  getSubmitWithdrawRequestHash,
  encodeWithdrawal,
  getWithdrawRequestHash,
  DenormalizedWithdrawRequest,
  normalizeWithdrawRequest,
  WithdrawRequest,
  DepositAddressTrigger,
  getDepositAddressTriggerHash,
  encodeAddress,
} from "@relay-protocol/settlement-sdk";
import axios from "axios";
import * as bitcoin from "bitcoinjs-lib";
import TronWeb from "tronweb";
import {
  Address,
  decodeAbiParameters,
  getContract,
  Hex,
  parseAbi,
  verifyMessage,
  verifyTypedData,
  zeroAddress,
  zeroHash,
} from "viem";

import { getVmAttestor } from "./vm";
import { EnhancedDepositoryDepositMessage } from "./vm/types";
import {
  cartesianProduct,
  extractEcdsaSignature,
  getBitcoinSignerPubkey,
  getDeterministicId,
  normalizeBitcoinPartialSignature,
} from "./utils";
import {
  Chain,
  getChain,
  getChainVmType,
  getHubInfo,
  getSdkChainsConfig,
} from "../../common/chains";
import { externalError, internalError } from "../../common/error";
import {
  getAuroraHttpRpc,
  getBalanceOnHub,
  getHubHttpRpc,
} from "../../common/hub";

type ExecutionMetadata = Omit<
  ExecutionMessageMetadata,
  "oracleContract" | "oracleChainId"
>;

type WithdrawalAddressRequest = {
  chainId: string;
  depository?: string;
  currency: string;
  withdrawer: string;
  withdrawerChainId: string;
  recipient: string;
  withdrawalNonce: string;
};

export type TxHints = {
  "hyperliquid-vm"?: {
    user: string;
    timestamp: number;
  };
  "ton-vm"?: {
    // Solver wallet — required for fill/refund (TON has no global tx-hash
    // lookup). Unused for deposit (account = chain.depository).
    solverAddress?: string;
    // Tx logical time — required for deposit (direct lookup only, no scan
    // fallback on high-throughput depositories). Optional for fill/refund
    // (enables O(1) lookup vs scan-window fallback).
    lt?: string;
  };
};

// Per-input deposit hints, parallel to the fill-tx `hints` field.
export type InputHints = Array<
  { inputIndex: number } & Pick<TxHints, "ton-vm">
>;

const getInputHints = (
  inputIndex: number,
  inputHints: InputHints | undefined,
): TxHints | undefined => {
  const entry = inputHints?.find((h) => h.inputIndex === inputIndex);
  if (!entry) {
    return undefined;
  }
  const { inputIndex: _idx, ...rest } = entry;
  return rest;
};

export class AttestationService {
  public async attestDepositoryDeposits(
    data: DepositoryDepositMessage["data"] & { hints?: TxHints },
  ): Promise<{
    messages: DepositoryDepositMessage[];
    execution?: ExecutionMessage;
  }> {
    const attestor = await getVmAttestor(data.chainId);
    const messages = await attestor.getDepositoryDepositMessages(
      data.chainId,
      data.transactionId,
      data.hints,
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
            chainId: m.data.chainId,
            family: await getChainVmType(m.data.chainId),
          };

          const hubTokenId = generateTokenId(origin);
          metadata.push({
            hubTokenId,
            origin,
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
                  chainId: m.data.chainId,
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

      const hubInfo = await getHubInfo();
      execution = {
        idempotencyKey: getDeterministicId(data.chainId, data.transactionId),
        actions,
        metadata: metadata.map((md) => ({
          ...md,
          oracleChainId: hubInfo.evmChainId,
          oracleContract: hubInfo.oracleAddress as Address,
        })),
      };
    }

    return {
      messages,
      execution,
    };
  }

  public async attestWithdrawalInitiation(
    data: DenormalizedSubmitWithdrawRequest,
  ): Promise<{
    withdrawalAddress: string;
    execution: ExecutionMessage;
  }> {
    // Ensure the amount is non-zero
    if (BigInt(data.amount) <= 0) {
      throw externalError("Withdrawn amount must be non-zero");
    }

    // The token to be withdrawn from depository
    const hubTokenId = generateTokenId({
      address: data.currency,
      chainId: data.chainId,
      family: await getChainVmType(data.chainId),
    });

    // Safety check to ensure the owner has sufficient balance
    const balance = await getBalanceOnHub(data.spender, hubTokenId);
    if (!balance || BigInt(balance) < BigInt(data.amount)) {
      throw externalError("Insufficient balance for requested withdrawal");
    }

    // Compute withdrawal address
    const chain = await getChain(data.chainId);
    const depository = this._getConfiguredDepository(chain, data.depository);
    const withdrawalAddress = getWithdrawalAddress({
      vmType: chain.vmType,
      chainId: data.chainId,
      depository,
      currency: data.currency,
      recipient: data.recipient,
      ownerAlias: data.spender,
      nonce: data.nonce,
    });

    const hubInfo = await getHubInfo();
    const execution = {
      idempotencyKey: getDeterministicId(
        hubInfo.id,
        hubTokenId.toString(),
        withdrawalAddress,
      ),
      actions: [
        encodeAction({
          type: ActionType.TRANSFER,
          data: {
            hubTokenId: hubTokenId,
            hubFromAddress: data.spender,
            hubToAddress: withdrawalAddress,
            amount: data.amount,
          },
        }),
      ],
    };

    return {
      withdrawalAddress,
      execution,
    };
  }

  public async attestTransfer(data: {
    chainId: string;
    currency: string;
    amount: string;
    from: string;
    to: string;
    nonce: string;
  }): Promise<{
    execution: ExecutionMessage;
  }> {
    // Ensure the amount is non-zero
    if (BigInt(data.amount) <= 0) {
      throw externalError("Transfer amount must be non-zero");
    }

    // The hub token being transferred
    const hubTokenId = generateTokenId({
      address: data.currency,
      chainId: data.chainId,
      family: await getChainVmType(data.chainId),
    });

    // Safety check to ensure the alias has sufficient balance
    const balance = await getBalanceOnHub(data.from, hubTokenId);
    if (!balance || BigInt(balance) < BigInt(data.amount)) {
      throw externalError("Insufficient balance for requested transfer");
    }

    const hubInfo = await getHubInfo();
    const execution: ExecutionMessage = {
      idempotencyKey: getDeterministicId(
        hubInfo.id,
        hubTokenId.toString(),
        data.from,
        data.to,
        data.nonce,
      ),
      actions: [
        encodeAction({
          type: ActionType.TRANSFER,
          data: {
            hubTokenId,
            hubFromAddress: data.from,
            hubToAddress: data.to,
            amount: data.amount,
          },
        }),
      ],
    };

    return {
      execution,
    };
  }

  public async attestWithdrawalInitiated(
    data: DenormalizedSubmitWithdrawRequest,
  ): Promise<{
    payloadParams: SubmitWithdrawRequest;
  }> {
    // Ensure the amount is non-zero
    if (BigInt(data.amount) <= 0) {
      throw externalError("Withdrawn amount must be non-zero");
    }

    // The token to be withdrawn from depository
    const hubTokenId = generateTokenId({
      address: data.currency,
      chainId: data.chainId,
      family: await getChainVmType(data.chainId),
    });

    // Compute withdrawal address
    const chain = await getChain(data.chainId);
    const depository = this._getConfiguredDepository(chain, data.depository);
    const withdrawalAddress = getWithdrawalAddress({
      vmType: chain.vmType,
      chainId: data.chainId,
      depository,
      currency: data.currency,
      recipient: data.recipient,
      ownerAlias: data.spender,
      nonce: data.nonce,
    });

    // Safety check to ensure the withdrawn amount matches the withdrawal address balance
    const balance = await getBalanceOnHub(withdrawalAddress, hubTokenId);
    if (BigInt(balance) !== BigInt(data.amount)) {
      throw externalError(
        "Withdrawn amount different from withdrawal address balance",
      );
    }

    const payloadParams = await this._getPayloadParams(data);

    return {
      payloadParams,
    };
  }

  public async attestDepositoryWithdrawal(
    data: DepositoryWithdrawalMessage["data"] & {
      transactionId?: string;
      hints?: TxHints;
      withdrawalAddressRequest: WithdrawalAddressRequest;
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
        data.hints,
      ),
    );

    // Generate onchain hub execution
    const { withdrawalAddress, hubTokenId, withdrawerAlias } =
      await this._getWithdrawalAddress(data.withdrawalAddressRequest);

    const decodedWithdrawal = decodeWithdrawal(
      data.withdrawal,
      await getChainVmType(data.chainId),
    );
    const amount = getDecodedWithdrawalAmount(decodedWithdrawal);

    let execution: ExecutionMessage | undefined;
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

    return {
      message,
      execution,
    };
  }

  public async attestDepositoryWithdrawalV2(
    data: DenormalizedSubmitWithdrawRequest & {
      transactionId?: string;
      hints?: TxHints;
      withdrawalAddressRequest: WithdrawalAddressRequest;
    },
  ): Promise<{
    status: DepositoryWithdrawalStatus;
    execution?: ExecutionMessage;
  }> {
    const payloadParams = await this._getPayloadParams(data);

    // A single withdrawal can have more than one valid encoding - an allocator
    // input may have been signed more than once (eg retried NEAR MPC signing),
    // and the transaction that actually landed on-chain might use any of those
    // signatures. Each combination yields a distinct (but equivalent) signed
    // payload, so we check them all and treat the withdrawal as executed if any
    // of them matches the on-chain spend.
    const withdrawals = await this._getEncodedWithdrawalV2(
      data.chainId,
      payloadParams,
    );

    if (!withdrawals.length) {
      return { status: DepositoryWithdrawalStatus.PENDING };
    }

    const results = await Promise.all(
      withdrawals.map((withdrawal) =>
        this.attestDepositoryWithdrawal({
          chainId: data.chainId,
          withdrawal,
          transactionId: data.transactionId,
          hints: data.hints,
          withdrawalAddressRequest: data.withdrawalAddressRequest,
        }),
      ),
    );

    // If any of the withdrawal encodings is executed, then we mark the withdrawal as executed
    const executedResult = results.find(
      (r) => r.message.result.status === DepositoryWithdrawalStatus.EXECUTED,
    );
    if (executedResult) {
      return {
        status: executedResult.message.result.status,
        execution: executedResult.execution,
      };
    }

    // If all of the withdrawal encodings are expired, then we mark the withdrawal as expired
    if (
      results.every(
        (result) =>
          result.message.result.status === DepositoryWithdrawalStatus.EXPIRED,
      )
    ) {
      return {
        status: results[0].message.result.status,
        execution: results[0].execution,
      };
    }

    // Otheriwse, the withdrawal is still pending
    return { status: DepositoryWithdrawalStatus.PENDING };
  }

  public async attestDepositoryWithdrawalV3(
    data: DenormalizedWithdrawRequest & {
      transactionId?: string;
      hints?: TxHints;
    },
  ): Promise<{
    status: DepositoryWithdrawalStatus;
    execution?: ExecutionMessage;
  }> {
    const chain = await getChain(data.chainId);
    const withdrawRequest = normalizeWithdrawRequest({
      ...data,
      depository: this._getConfiguredDepository(chain, data.depository),
      vmType: await getChainVmType(data.chainId),
      spenderVmType: await getChainVmType(data.spenderChainId),
    });

    const message = await getVmAttestor(withdrawRequest.chainId).then(
      async (attestor) =>
        attestor.getDepositoryWithdrawalMessage(
          withdrawRequest.chainId,
          await this._getEncodedWithdrawalV3(withdrawRequest),
          data.transactionId,
          data.hints,
        ),
    );

    let execution: ExecutionMessage | undefined;
    if (message.result.status === DepositoryWithdrawalStatus.EXPIRED) {
      const withdrawRequestHash = getWithdrawRequestHash(withdrawRequest);

      const hubTokenId = generateTokenId({
        address: data.currency,
        chainId: withdrawRequest.chainId,
        family: await getChainVmType(withdrawRequest.chainId),
      });

      const hubToAddress = generateAddress({
        address: data.spender,
        chainId: withdrawRequest.spenderChainId,
        family: await getChainVmType(withdrawRequest.spenderChainId),
      });

      // Mint back the funds to the spender
      execution = {
        idempotencyKey: getDeterministicId(
          withdrawRequestHash,
          DepositoryWithdrawalStatus.EXPIRED.toString(),
        ),
        actions: [
          encodeAction({
            type: ActionType.MINT,
            data: {
              hubTokenId,
              hubToAddress,
              amount: withdrawRequest.amount,
            },
          }),
        ],
      };
    }

    return {
      status: message.result.status,
      execution,
    };
  }

  public async attestSolverFill(
    data: SolverFillMessage["data"] & {
      hints?: TxHints;
      inputHints?: InputHints;
      force?: boolean;
    },
  ): Promise<{ message: SolverFillMessage; execution?: ExecutionMessage }> {
    const orderId = getOrderId(data.order, await getSdkChainsConfig());
    if (data.force) {
      const depositoryDeposits: EnhancedDepositoryDepositMessage[] = [];
      for (const input of data.inputs) {
        const chainId =
          (input as any).chainId ??
          data.order.inputs[input.inputIndex].payment.chainId;
        depositoryDeposits.push(
          ...(await getVmAttestor(chainId)
            .then((attestor) =>
              attestor.getDepositoryDepositMessages(
                chainId,
                input.transactionId,
                getInputHints(input.inputIndex, data.inputHints),
              ),
            )
            .then((deposits) =>
              deposits.filter((d) => d.result.depositId === orderId),
            )),
        );
      }

      const execution = await this._getSolverFillOrRefundExecution({
        order: data.order,
        depositoryDeposits,
        totalWeightedInputPaymentBpsDiff: 0n,
        type: "fill",
      });

      return {
        message: {
          data,
          result: {
            orderId,
            status: SolverFillStatus.SUCCESSFUL,
            totalWeightedInputPaymentBpsDiff: "0",
          },
        },
        execution,
      };
    }

    const { totalWeightedInputPaymentBpsDiff, depositoryDeposits } =
      await this._getDepositsDetails(data);

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

      const minimumAmount = BigInt(payment.minimumAmount);
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
    data: SolverRefundMessage["data"] & {
      hints?: TxHints;
      inputHints?: InputHints;
      force?: boolean;
    },
  ): Promise<{ message: SolverRefundMessage; execution?: ExecutionMessage }> {
    const orderId = getOrderId(data.order, await getSdkChainsConfig());
    if (data.force) {
      const depositoryDeposits: EnhancedDepositoryDepositMessage[] = [];
      for (const input of data.inputs) {
        const chainId =
          (input as any).chainId ??
          data.order.inputs[input.inputIndex].payment.chainId;
        depositoryDeposits.push(
          ...(await getVmAttestor(chainId)
            .then((attestor) =>
              attestor.getDepositoryDepositMessages(
                chainId,
                input.transactionId,
                getInputHints(input.inputIndex, data.inputHints),
              ),
            )
            .then((deposits) =>
              deposits.filter((d) => d.result.depositId === orderId),
            )),
        );
      }

      const execution = await this._getSolverFillOrRefundExecution({
        order: data.order,
        depositoryDeposits,
        totalWeightedInputPaymentBpsDiff: 0n,
        type: "refund",
      });

      return {
        message: {
          data,
          result: {
            orderId,
            status: SolverRefundStatus.SUCCESSFUL,
            totalWeightedInputPaymentBpsDiff: "0",
          },
        },
        execution,
      };
    }

    const { totalWeightedInputPaymentBpsDiff, depositoryDeposits } =
      await this._getDepositsDetails(data);

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
          orderId,
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

  public async attestDepositAddressTrigger(
    data: DepositAddressTrigger,
  ): Promise<{
    chainId: string;
    depositAddressManager: string;
    inputDepository: string;
    triggerHash: string;
  }> {
    const hubInfo = await getHubInfo();
    if (!hubInfo.depositAddressManagerAddress) {
      throw externalError("Missing deposit address manager config");
    }

    const inputChain = await getChain(data.input.chainId);
    if (!inputChain?.depository) {
      throw externalError(
        `Missing depository for input chain ${data.input.chainId}`,
      );
    }
    const inputDepository = `0x${Buffer.from(
      encodeAddress(inputChain.depository, inputChain.vmType),
    ).toString("hex")}`;

    const triggerHash = getDepositAddressTriggerHash(data);

    const depositAddressManager = getContract({
      address: hubInfo.depositAddressManagerAddress as Address,
      abi: parseAbi([
        "function triggers(bytes32 triggerHash) view returns (bytes32)",
      ]),
      client: await getHubHttpRpc(),
    });
    const triggeredOrderId = await depositAddressManager.read.triggers([
      triggerHash as Hex,
    ]);
    if (triggeredOrderId !== data.orderId) {
      throw externalError("Trigger hash does not map to the provided order id");
    }

    return {
      chainId: hubInfo.evmChainId,
      depositAddressManager: hubInfo.depositAddressManagerAddress,
      inputDepository,
      triggerHash,
    };
  }

  public async attestNonceMappingSignature(data: {
    walletChainId: string;
    wallet: string;
    nonce: string;
    id: string;
    depositor: string;
    signatureChainId: string;
    signature: string;
  }): Promise<{
    genericMapping: GenericMappingMessage;
  }> {
    const NONCE_MAPPING_DOMAIN = (chainId: number) => ({
      name: "RelayNonceMapping",
      version: "2",
      chainId,
      verifyingContract: zeroAddress,
    });

    const NONCE_MAPPING_TYPES = {
      NonceMapping: [
        { name: "chainId", type: "string" },
        { name: "wallet", type: "address" },
        { name: "depositor", type: "address" },
        { name: "id", type: "bytes32" },
        { name: "nonce", type: "uint256" },
      ],
    };

    const message = {
      chainId: data.walletChainId,
      wallet: data.wallet as Address,
      depositor: data.depositor as Address,
      id: data.id as Hex,
      nonce: BigInt(data.nonce),
    };

    const signatureChain = await getChain(data.signatureChainId);
    if (signatureChain.vmType !== "ethereum-vm") {
      throw externalError("Unsupported signature chain");
    }

    const isValidSignature = await verifyTypedData({
      address: data.wallet as Address,
      domain: NONCE_MAPPING_DOMAIN(Number(signatureChain.hubChainId!)),
      types: NONCE_MAPPING_TYPES,
      primaryType: "NonceMapping",
      message,
      signature: data.signature as Hex,
    }).catch(() => false);
    if (!isValidSignature) {
      throw externalError("Invalid signature");
    }

    const walletChain = await getChain(data.walletChainId);
    const user = generateAddress({
      family: walletChain.vmType,
      chainId: walletChain.id,
      address: data.wallet,
    });

    return {
      genericMapping: getNonceMappingMessage(
        user,
        data.nonce,
        data.id,
        data.depositor,
      ),
    };
  }

  public async attestNoFillOrRefundSignature(data: {
    solverChainId: string;
    solver: string;
    orderId: string;
    signature: string;
  }): Promise<{
    genericMapping: GenericMappingMessage;
  }> {
    const NO_FILL_OR_REFUND_DOMAIN = (chainId: number) => ({
      name: "RelayNoFillOrRefund",
      version: "1",
      chainId,
      verifyingContract: zeroAddress,
    });

    const NO_FILL_OR_REFUND_TYPES = {
      NoFillOrRefund: [
        { name: "chainId", type: "string" },
        { name: "solver", type: "address" },
        { name: "orderId", type: "bytes32" },
      ],
    };

    const solverChain = await getChain(data.solverChainId);
    if (solverChain.vmType !== "ethereum-vm") {
      throw externalError("Unsupported signature chain");
    }

    const message = {
      chainId: data.solverChainId,
      solver: data.solver as Address,
      orderId: data.orderId as Hex,
    };

    const isValidSignature = await verifyTypedData({
      address: data.solver as Address,
      domain: NO_FILL_OR_REFUND_DOMAIN(Number(solverChain.hubChainId!)),
      types: NO_FILL_OR_REFUND_TYPES,
      primaryType: "NoFillOrRefund",
      message,
      signature: data.signature as Hex,
    }).catch(() => false);
    if (!isValidSignature) {
      throw externalError("Invalid signature");
    }

    const solver = generateAddress({
      family: solverChain.vmType,
      chainId: solverChain.id,
      address: data.solver,
    });

    return {
      genericMapping: getNoFillOrRefundMessage(solver, data.orderId),
    };
  }

  public async attestWithdrawRequest(
    data: DenormalizedWithdrawRequest & { hashIndexes: number[] },
  ): Promise<{
    chainId: number;
    allocator: string;
    withdrawRequestHash: string;
    hashesToSign: string[];
  }> {
    const hubInfo = await getHubInfo();
    const withdrawRequest = normalizeWithdrawRequest({
      ...data,
      vmType: await getChainVmType(data.chainId),
      spenderVmType: await getChainVmType(data.spenderChainId),
    });
    const withdrawRequestHash = getWithdrawRequestHash(withdrawRequest);

    const allocator = getContract({
      address: hubInfo.allocatorAddress as Address,
      abi: parseAbi([
        "function hashesToSign(bytes32 withdrawRequestHash, uint256 index) view returns (bytes32)",
      ]),
      client: await getHubHttpRpc(),
    });
    const hashesToSign = await Promise.all(
      data.hashIndexes.map(async (hashIndex) => {
        const hashToSign = await allocator.read.hashesToSign([
          withdrawRequestHash as Hex,
          BigInt(hashIndex),
        ]);
        if (hashToSign === zeroHash) {
          throw externalError(
            `Hash to sign not set for withdraw request at index ${hashIndex}`,
          );
        }
        return hashToSign;
      }),
    );

    return {
      chainId: Number(hubInfo.evmChainId),
      allocator: hubInfo.allocatorAddress,
      withdrawRequestHash,
      hashesToSign,
    };
  }

  // Shared validation: order matches on-chain deposit + solver signed it +
  // solver declared no-fill-or-refund on hub. Used by attestRecover (≤7d path)
  // and recoverMode-based withdrawal initiation (slow refund).
  public async validateOrderForDeposit(params: {
    deposit: DepositoryDepositMessage;
    order: Order;
    orderSignature: string;
  }): Promise<{ orderId: string }> {
    const orderId = getOrderId(params.order, await getSdkChainsConfig());
    if (params.deposit.result.depositId !== orderId) {
      throw externalError(
        "Deposit depositId does not match the computed orderId",
      );
    }

    const isSignatureValid = await verifyMessage({
      address: params.order.solver as Address,
      message: { raw: orderId },
      signature: params.orderSignature as Hex,
    }).catch(() => false);
    if (!isSignatureValid) {
      throw externalError("Invalid order signature");
    }

    const solverAlias = generateAddress({
      address: params.order.solver,
      chainId: params.order.solverChainId,
      family: await getChainVmType(params.order.solverChainId),
    });

    const noFillOrRefundMessage = getNoFillOrRefundMessage(
      solverAlias,
      orderId,
    );

    const hubInfo = await getHubInfo();
    const genericMappingContract = getContract({
      address: hubInfo.genericMappingAddress as Address,
      abi: parseAbi([
        "function getEntry(address user, bytes32 id) view returns (bytes data, uint256 createdAt)",
      ]),
      client: await getHubHttpRpc(),
    });

    const [, createdAt] = await genericMappingContract.read.getEntry([
      noFillOrRefundMessage.user as Address,
      noFillOrRefundMessage.id as Hex,
    ]);
    if (createdAt === 0n) {
      throw externalError("No fill or refund entry not found for this order");
    }

    return { orderId };
  }

  public async attestRecover(data: {
    chainId: string;
    transactionId: string;
    onchainId: string;
    order?: Order;
    orderSignature?: string;
    hints?: TxHints;
  }): Promise<{ execution: ExecutionMessage }> {
    // Fetch all deposits from the transaction
    const attestor = await getVmAttestor(data.chainId);
    const deposits = await attestor.getDepositoryDepositMessages(
      data.chainId,
      data.transactionId,
      data.hints,
    );

    // Find the specific deposit
    const deposit = deposits.find((d) => d.result.onchainId === data.onchainId);
    if (!deposit) {
      throw externalError(
        `Deposit with onchainId ${data.onchainId} not found in transaction`,
      );
    }

    // Must have a depositId (linked to an order)
    if (deposit.result.depositId === zeroHash) {
      throw externalError("Deposit does not have a depositId");
    }

    // Compute the order address on the hub
    const orderAddress = await this._getOrderAddress({
      chainId: data.chainId,
      timestamp: deposit.extraData.timestamp,
      depositor: deposit.result.depositor,
      depositId: deposit.result.depositId,
    });

    // Compute hubTokenId
    const hubTokenId = generateTokenId({
      address: deposit.result.currency,
      chainId: data.chainId,
      family: await getChainVmType(data.chainId),
    });

    // Balance check
    const balance = await getBalanceOnHub(orderAddress, hubTokenId);
    if (balance < BigInt(deposit.result.amount)) {
      throw externalError("Insufficient balance at order address for recovery");
    }

    // Compute depositor hub alias
    const depositorAlias = generateAddress({
      address: deposit.result.depositor,
      chainId: data.chainId,
      family: await getChainVmType(data.chainId),
    });

    // Check deposit age
    const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;
    const depositTimestamp = Number(deposit.extraData.timestamp);
    const now = Math.floor(Date.now() / 1000);
    const isOlderThan7Days = now - depositTimestamp > SEVEN_DAYS_SECONDS;

    if (!isOlderThan7Days) {
      // Require order data for deposits <= 7 days old
      if (!data.order || !data.orderSignature) {
        throw externalError(
          "Order data and signature are required for deposits less than 7 days old",
        );
      }

      await this.validateOrderForDeposit({
        deposit,
        order: data.order,
        orderSignature: data.orderSignature,
      });
    }

    // Sign TRANSFER from order address to depositor alias
    const execution: ExecutionMessage = {
      idempotencyKey: getDeterministicId(deposit.result.onchainId, "recover"),
      actions: [
        encodeAction({
          type: ActionType.TRANSFER,
          data: {
            hubTokenId,
            hubFromAddress: orderAddress,
            hubToAddress: depositorAlias,
            amount: deposit.result.amount,
          },
        }),
      ],
    };

    return { execution };
  }

  private async _getDepositsDetails(data: {
    order: Order;
    orderSignature: string;
    inputs: {
      transactionId: string;
      onchainId: string;
      inputIndex: number;
    }[];
    inputHints?: InputHints;
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
            getInputHints(inputInformation.inputIndex, data.inputHints),
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
      chainId: data.order.solverChainId,
      family: await getChainVmType(data.order.solverChainId),
    });

    // Transfer from order to solver
    for (const deposit of data.depositoryDeposits) {
      const hubTokenId = generateTokenId({
        address: deposit.result.currency,
        chainId: deposit.data.chainId,
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
          chainId: fee.currencyChainId,
          family: await getChainVmType(fee.currencyChainId),
        });

        const hubToAddress = generateAddress({
          address: fee.recipient,
          chainId: fee.recipientChainId,
          family: await getChainVmType(fee.recipientChainId),
        });

        const amount = fee.amount;
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

    // Ensure we never return empty actions
    if (!actions.length) {
      throw internalError("Missing actions to execute");
    }

    // Sort and generate a unique id for the relevant deposits
    const sortedDepositIds = data.depositoryDeposits
      .map((deposit) => deposit.result.onchainId)
      .sort((a, b) => (BigInt(a) - BigInt(b) <= 0 ? -1 : 1));
    const depositsId = getDeterministicId(...sortedDepositIds);

    return {
      // The idempotency key includes the deposits id in order to support duplicate deposit fills / refunds
      idempotencyKey: getDeterministicId(
        depositsId,
        getOrderId(data.order, await getSdkChainsConfig()),
      ),
      actions,
    };
  }

  private async _getOrderAddress(data: {
    chainId: string;
    timestamp: string;
    depositor: string;
    depositId: string;
  }): Promise<string> {
    return getOrderAddress({
      vmType: await getChainVmType(data.chainId),
      chainId: data.chainId,
      depositor: data.depositor,
      timestamp: BigInt(data.timestamp),
      depositId: data.depositId,
    });
  }

  private _getConfiguredDepository(
    chain: Chain,
    requestedDepository?: string,
  ) {
    const depository = requestedDepository ?? chain.depository;
    if (!depository) {
      throw externalError("Chain has no depository configured");
    }

    if (
      requestedDepository &&
      requestedDepository !== chain.depository &&
      !chain.additionalDepositories?.includes(requestedDepository)
    ) {
      throw externalError(
        `Depository ${requestedDepository} is not configured for chain ${chain.id}`,
      );
    }

    return depository;
  }

  private async _getWithdrawalAddress(data: WithdrawalAddressRequest) {
    const chain = await getChain(data.chainId);

    // The token to be withdrawn from depository
    const hubTokenId = generateTokenId({
      address: data.currency,
      chainId: data.chainId,
      family: await getChainVmType(data.chainId),
    });

    // The alias for withdrawer address on origin chain
    const withdrawerAlias = generateAddress({
      address: data.withdrawer,
      chainId: data.withdrawerChainId,
      family: await getChainVmType(data.withdrawerChainId),
    });

    // Compute address
    const depository = this._getConfiguredDepository(chain, data.depository);
    const withdrawalAddress = getWithdrawalAddress({
      depository,
      chainId: data.chainId,
      vmType: await getChainVmType(data.chainId),
      recipient: data.recipient,
      currency: data.currency,
      ownerAlias: withdrawerAlias,
      nonce: data.withdrawalNonce,
    });

    return {
      hubTokenId,
      withdrawalAddress,
      withdrawerAlias,
    };
  }

  private async _getPayloadParams(data: DenormalizedSubmitWithdrawRequest) {
    const chain = await getChain(data.chainId);

    const attestor = await getVmAttestor(data.chainId);
    await attestor.validateSubmitWithdrawRequest(data);

    const payloadParams = normalizePayloadParams({
      ...data,
      depository: this._getConfiguredDepository(chain, data.depository),
      chainId: chain.hubChainId!,
      vmType: chain.vmType,
    });

    return payloadParams;
  }

  private async _getEncodedWithdrawalV2(
    chainId: string,
    payloadParams: SubmitWithdrawRequest,
  ): Promise<string[]> {
    const hubInfo = await getHubInfo();

    const allocator = getContract({
      address: hubInfo.auroraAllocatorAddress as Address,
      abi: parseAbi([
        "function payloads(bytes32 payloadId) view returns (bytes unsignedPayload)",
        "function payloadTimestamps(bytes32 payloadId) view returns (uint256 timestamp)",
        "function payloadBuilders(uint256 chainId, string depository) view returns (address)",
        "function signedPayloads(bytes32 payloadId, bytes32 hashToSign) view returns (bytes)",
      ]),
      client: await getAuroraHttpRpc(),
    });

    const payloadBuilderAddress = await allocator.read.payloadBuilders([
      BigInt(payloadParams.chainId),
      payloadParams.depository,
    ]);
    if (payloadBuilderAddress === zeroAddress) {
      throw externalError(
        `No payload builder configured for chain ${payloadParams.chainId}`,
      );
    }

    const payloadBuilder = getContract({
      address: payloadBuilderAddress,
      abi: parseAbi([
        "function family() view returns (string)",
        "function hashToSign(uint256 chainId, string depository, bytes payload, uint32 index) view returns (bytes32)",
      ]),
      client: await getAuroraHttpRpc(),
    });
    const family = await payloadBuilder.read.family();

    const depository =
      family === "tron-vm"
        ? TronWeb.utils.address
            .toHex(payloadParams.depository)
            .replace(TronWeb.utils.address.ADDRESS_PREFIX_REGEX, "0x")
        : payloadParams.depository;

    const payloadId = getSubmitWithdrawRequestHash(payloadParams);
    const payload = await allocator.read.payloads([payloadId as Hex]);

    switch (family) {
      case "ethereum-vm":
      case "hyperliquid-vm":
      case "lighter-vm":
      case "tron-vm": {
        const hashToSign = await payloadBuilder.read.hashToSign([
          BigInt(payloadParams.chainId),
          depository,
          payload,
          0,
        ]);

        const signature = await allocator.read.signedPayloads([
          payloadId as Hex,
          hashToSign,
        ]);
        return signature === "0x" ? [] : [payload];
      }

      case "solana-vm": {
        const hashToSign = await payloadBuilder.read.hashToSign([
          BigInt(payloadParams.chainId),
          depository,
          payload,
          0,
        ]);

        const signature = await allocator.read.signedPayloads([
          payloadId as Hex,
          hashToSign,
        ]);
        return signature === "0x" ? [] : [payload];
      }

      case "bitcoin-vm": {
        const transactionData = this._decodeBitcoinTransactionData(
          payload as Hex,
        );

        // For every input, gather all signatures the allocator produced for it.
        // An input can legitimately be signed more than once (eg a retried NEAR
        // MPC signing), each producing a different but valid signature, and the
        // the transaction that landed on-chain may use any of them.
        const perInputSignatures = await Promise.all(
          transactionData.inputs.map(async (_, i) => {
            const hashToSign = await payloadBuilder.read.hashToSign([
              BigInt(payloadParams.chainId),
              depository,
              payload,
              i,
            ]);
            const storedSignature = await allocator.read.signedPayloads([
              payloadId as Hex,
              hashToSign,
            ]);

            const signatures = new Set<string>();
            if (storedSignature && storedSignature !== "0x") {
              signatures.add(extractEcdsaSignature(storedSignature));
            }

            const PAYLOAD_WITHDRAW_SIGNED_TOPIC =
              "0x0442d576de21d369ae594c20a06e751211e214c91de4b237e5f66edd1900f1f9";
            const response = await axios.post(hubInfo.auroraHttpRpcUrl, {
              jsonrpc: "2.0",
              id: 1,
              method: "eth_getLogs",
              params: [
                {
                  fromBlock: "earliest",
                  toBlock: "latest",
                  address: hubInfo.auroraAllocatorAddress,
                  topics: [
                    PAYLOAD_WITHDRAW_SIGNED_TOPIC,
                    payloadId,
                    hashToSign,
                  ],
                },
              ],
            });
            if (response.data?.error) {
              throw internalError(
                `Allocator signature lookup failed: ${JSON.stringify(
                  response.data.error,
                )}`,
              );
            }

            for (const log of response.data?.result ?? []) {
              const [signedPayload] = decodeAbiParameters(
                [{ type: "bytes" }],
                log.data as Hex,
              ) as [Hex];
              signatures.add(extractEcdsaSignature(signedPayload));
            }

            return [...signatures];
          }),
        );

        // If any input has no signature, the payload is not yet fully signed.
        if (perInputSignatures.some((signatures) => !signatures.length)) {
          return [];
        }

        const signerPublicKey = await getBitcoinSignerPubkey(chainId);

        // Build one encoded withdrawal for a specific choice of signature per input.
        const buildEncodedWithdrawal = (inputSignatures: string[]) =>
          this._encodeBitcoinPsbtWithdrawal({
            transactionData,
            inputSignatures,
            signerPublicKey,
          });

        // One candidate withdrawal per combination of per-input signatures
        const combinations = cartesianProduct(perInputSignatures);
        if (combinations.length > 100) {
          throw internalError(
            "Too many input signature combinations to process",
          );
        }

        return combinations.map(buildEncodedWithdrawal);
      }

      default: {
        throw externalError("Vm type not implemented");
      }
    }
  }

  private async _getEncodedWithdrawalV3(
    withdrawRequest: WithdrawRequest,
  ): Promise<string> {
    const hubInfo = await getHubInfo();

    const allocator = getContract({
      address: hubInfo.allocatorAddress as Address,
      abi: parseAbi([
        "function payloads(bytes32 withdrawRequestHash) view returns (bytes unsignedPayload)",
        "function payloadBuilders(string chainId, bytes depository) view returns (address)",
      ]),
      client: await getHubHttpRpc(),
    });

    const payloadBuilderAddress = await allocator.read.payloadBuilders([
      withdrawRequest.chainId,
      withdrawRequest.depository as Hex,
    ]);
    if (payloadBuilderAddress === zeroAddress) {
      throw externalError(
        `No payload builder configured for chain ${withdrawRequest.chainId}`,
      );
    }

    const payloadBuilder = getContract({
      address: payloadBuilderAddress,
      abi: parseAbi(["function family() view returns (string)"]),
      client: await getHubHttpRpc(),
    });
    const family = await payloadBuilder.read.family();

    const withdrawRequestHash = getWithdrawRequestHash(withdrawRequest);
    const payload = await allocator.read.payloads([withdrawRequestHash as Hex]);
    if (payload === "0x") {
      throw externalError("Withdraw request not yet available");
    }

    switch (family) {
      case "ethereum-vm":
      case "hyperliquid-vm":
      case "lighter-vm":
      case "solana-vm":
      case "ton-vm":
      case "tron-vm": {
        return payload;
      }

      case "bitcoin-vm": {
        return this._encodeBitcoinPsbtWithdrawal({
          transactionData: this._decodeBitcoinTransactionData(payload as Hex),
        });
      }

      default: {
        throw externalError("Vm type not implemented");
      }
    }
  }

  private _decodeBitcoinTransactionData(encodedData: Hex): {
    inputs: { txid: Hex; index: Hex; script: Hex; value: Hex }[];
    outputs: { value: Hex; script: Hex }[];
  } {
    return decodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            {
              type: "tuple[]",
              name: "inputs",
              components: [
                { type: "bytes", name: "txid" },
                { type: "bytes", name: "index" },
                { type: "bytes", name: "script" },
                { type: "bytes", name: "value" },
              ],
            },
            {
              type: "tuple[]",
              name: "outputs",
              components: [
                { type: "bytes", name: "value" },
                { type: "bytes", name: "script" },
              ],
            },
          ],
        },
      ],
      encodedData,
    )[0] as {
      inputs: { txid: Hex; index: Hex; script: Hex; value: Hex }[];
      outputs: { value: Hex; script: Hex }[];
    };
  }

  private _fromBitcoinLittleEndian(value: Hex): number {
    const bytes = Buffer.from(value.slice(2), "hex");
    const reversed = Buffer.from(bytes).reverse();
    const normalized = reversed.toString("hex").replace(/^0+/, "") || "0";
    return Number(BigInt(`0x${normalized}`));
  }

  private _encodeBitcoinPsbtWithdrawal(data: {
    transactionData: {
      inputs: { txid: Hex; index: Hex; script: Hex; value: Hex }[];
      outputs: { value: Hex; script: Hex }[];
    };
    inputSignatures?: string[];
    signerPublicKey?: Buffer;
  }): string {
    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });
    psbt.setVersion(1);

    for (const input of data.transactionData.inputs) {
      const txid = Buffer.from(input.txid.slice(2), "hex")
        .reverse()
        .toString("hex");

      psbt.addInput({
        hash: txid,
        index: this._fromBitcoinLittleEndian(input.index),
        sequence: 0xfffffffd,
        sighashType: bitcoin.Transaction.SIGHASH_ALL,
        witnessUtxo: {
          script: Buffer.from(input.script.slice(2), "hex"),
          value: this._fromBitcoinLittleEndian(input.value),
        },
        ...(data.signerPublicKey
          ? {
              // The allocator pubkey is included so signers can identify inputs by key
              bip32Derivation: [
                {
                  masterFingerprint: Buffer.alloc(4),
                  path: "m",
                  pubkey: data.signerPublicKey,
                },
              ],
            }
          : {}),
      });
    }

    for (const output of data.transactionData.outputs) {
      psbt.addOutput({
        script: Buffer.from(output.script.slice(2), "hex"),
        value: this._fromBitcoinLittleEndian(output.value),
      });
    }

    if (data.inputSignatures) {
      if (!data.signerPublicKey) {
        throw internalError("Missing bitcoin signer public key");
      }

      for (let i = 0; i < data.inputSignatures.length; i++) {
        const partialSig = psbt.data.inputs[i].partialSig ?? [];
        const normalizedSignature = normalizeBitcoinPartialSignature(
          data.inputSignatures[i],
          bitcoin.Transaction.SIGHASH_ALL,
        );

        psbt.updateInput(i, {
          partialSig: [
            ...partialSig,
            {
              pubkey: data.signerPublicKey,
              signature: normalizedSignature,
            },
          ],
        });
      }
    }

    return encodeWithdrawal({
      vmType: "bitcoin-vm",
      withdrawal: { psbt: psbt.toHex() },
    });
  }
}

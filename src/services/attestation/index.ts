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
} from "@relay-protocol/settlement-sdk";
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
  extractEcdsaSignature,
  getBitcoinSignerPubkey,
  getDeterministicId,
  normalizeBitcoinPartialSignature,
} from "./utils";
import {
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
    const withdrawalAddress = getWithdrawalAddress({
      vmType: chain.vmType,
      chainId: data.chainId,
      depository: chain.depository!,
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
    const withdrawalAddress = getWithdrawalAddress({
      vmType: chain.vmType,
      chainId: data.chainId,
      depository: chain.depository!,
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
      withdrawalAddressRequest: WithdrawalAddressRequest;
    },
  ): Promise<{
    status: DepositoryWithdrawalStatus;
    execution?: ExecutionMessage;
  }> {
    const payloadParams = await this._getPayloadParams(data);
    const withdrawal = await this._getEncodedWithdrawal(
      data.chainId,
      payloadParams,
    );

    if (!withdrawal) {
      return { status: DepositoryWithdrawalStatus.PENDING };
    }

    const result = await this.attestDepositoryWithdrawal({
      chainId: data.chainId,
      withdrawal,
      transactionId: data.transactionId,
      withdrawalAddressRequest: data.withdrawalAddressRequest,
    });

    return {
      status: result.message.result.status,
      execution: result.execution,
    };
  }

  public async attestSolverFill(
    data: SolverFillMessage["data"] & { hints?: TxHints } & {
      force?: boolean;
      forceOrderId?: string;
    },
  ): Promise<{ message: SolverFillMessage; execution?: ExecutionMessage }> {
    const orderId =
      data.forceOrderId ?? getOrderId(data.order, await getSdkChainsConfig());
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
    data: SolverRefundMessage["data"] & { hints?: TxHints } & {
      force?: boolean;
      forceOrderId?: string;
    },
  ): Promise<{ message: SolverRefundMessage; execution?: ExecutionMessage }> {
    const orderId =
      data.forceOrderId ?? getOrderId(data.order, await getSdkChainsConfig());
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

  public async attestNonceMappingSignature(data: {
    walletChainId: string;
    wallet: string;
    nonce: string;
    id: string;
    signatureChainId: string;
    signature: string;
  }): Promise<{
    genericMapping: GenericMappingMessage;
  }> {
    const NONCE_MAPPING_DOMAIN = (chainId: number) => ({
      name: "RelayNonceMapping",
      version: "1",
      chainId,
      verifyingContract: zeroAddress,
    });

    const NONCE_MAPPING_TYPES = {
      NonceMapping: [
        { name: "chainId", type: "string" },
        { name: "wallet", type: "address" },
        { name: "id", type: "bytes32" },
        { name: "nonce", type: "uint256" },
      ],
    };

    const message = {
      chainId: data.walletChainId,
      wallet: data.wallet as Address,
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
      genericMapping: getNonceMappingMessage(user, data.nonce, data.id),
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

  public async attestRecover(data: {
    chainId: string;
    transactionId: string;
    onchainId: string;
    order?: Order;
    orderSignature?: string;
  }): Promise<{ execution: ExecutionMessage }> {
    // Fetch all deposits from the transaction
    const attestor = await getVmAttestor(data.chainId);
    const deposits = await attestor.getDepositoryDepositMessages(
      data.chainId,
      data.transactionId,
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
      throw externalError(
        "Insufficient balance at order address for recovery",
      );
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

      // Compute orderId and verify it matches the deposit
      const orderId = getOrderId(data.order, await getSdkChainsConfig());
      if (deposit.result.depositId !== orderId) {
        throw externalError(
          "Deposit depositId does not match the computed orderId",
        );
      }

      // Verify order signature
      const isSignatureValid = await verifyMessage({
        address: data.order.solver as Address,
        message: { raw: orderId },
        signature: data.orderSignature as Hex,
      }).catch(() => false);
      if (!isSignatureValid) {
        throw externalError("Invalid order signature");
      }

      // Derive solver hub alias
      const solverAlias = generateAddress({
        address: data.order.solver,
        chainId: data.order.solverChainId,
        family: await getChainVmType(data.order.solverChainId),
      });

      // Check no_fill_or_refund on hub generic mapping contract
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
        throw externalError(
          "No fill or refund entry not found for this order",
        );
      }
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
    const withdrawalAddress = getWithdrawalAddress({
      depository: chain.depository!,
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
      chainId: chain.hubChainId!,
      vmType: chain.vmType,
    });

    return payloadParams;
  }

  private async _getEncodedWithdrawal(
    chainId: string,
    payloadParams: SubmitWithdrawRequest,
  ): Promise<string | undefined> {
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
        if (signature === "0x") {
          return undefined;
        } else {
          return payload;
        }
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
        if (signature === "0x") {
          return undefined;
        } else {
          return payload;
        }
      }

      case "bitcoin-vm": {
        const decodeBitcoinTransactionData = (encodedData: Hex) =>
          decodeAbiParameters(
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

        const transactionData = decodeBitcoinTransactionData(payload as Hex);
        const signatures = await Promise.all(
          transactionData.inputs.map(async (_, i) => {
            const hashToSign = await payloadBuilder.read.hashToSign([
              BigInt(payloadParams.chainId),
              depository,
              payload,
              i,
            ]);
            const signature = await allocator.read.signedPayloads([
              payloadId as Hex,
              hashToSign,
            ]);
            if (signature === "0x") {
              return undefined;
            } else {
              return extractEcdsaSignature(signature);
            }
          }),
        );
        if (signatures.some((signature) => !signature)) {
          return undefined;
        }

        const fromLittleEndian = (value: Hex): number => {
          const bytes = Buffer.from(value.slice(2), "hex");
          const reversed = Buffer.from(bytes).reverse();
          const normalized = reversed.toString("hex").replace(/^0+/, "") || "0";
          return Number(BigInt(`0x${normalized}`));
        };

        const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });
        psbt.setVersion(1);

        const signerPublicKey = await getBitcoinSignerPubkey(chainId);
        for (const input of transactionData.inputs) {
          const txid = Buffer.from(input.txid.slice(2), "hex")
            .reverse()
            .toString("hex");

          psbt.addInput({
            hash: txid,
            index: Number(fromLittleEndian(input.index)),
            sequence: 0xfffffffd,
            sighashType: bitcoin.Transaction.SIGHASH_ALL,
            witnessUtxo: {
              script: Buffer.from(input.script.slice(2), "hex"),
              value: fromLittleEndian(input.value),
            },
            // The allocator pubkey is included so signers can identify inputs by key
            bip32Derivation: [
              {
                masterFingerprint: Buffer.alloc(4),
                path: "m",
                pubkey: signerPublicKey,
              },
            ],
          });
        }

        for (const output of transactionData.outputs) {
          psbt.addOutput({
            script: Buffer.from(output.script.slice(2), "hex"),
            value: fromLittleEndian(output.value),
          });
        }

        if (signatures.length !== transactionData.inputs.length) {
          throw internalError(
            `Invalid bitcoin signature count: expected ${transactionData.inputs.length}, got ${signatures.length}`,
          );
        }

        for (let i = 0; i < signatures.length; i++) {
          const partialSig = psbt.data.inputs[i].partialSig ?? [];
          const normalizedSignature = normalizeBitcoinPartialSignature(
            signatures[i]!,
            bitcoin.Transaction.SIGHASH_ALL,
          );

          psbt.updateInput(i, {
            partialSig: [
              ...partialSig,
              {
                pubkey: signerPublicKey,
                signature: normalizedSignature,
              },
            ],
          });
        }

        return encodeWithdrawal({
          vmType: "bitcoin-vm",
          withdrawal: { psbt: psbt.toHex() },
        });
      }

      default: {
        throw externalError("Vm type not implemented");
      }
    }
  }
}

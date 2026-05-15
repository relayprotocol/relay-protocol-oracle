import { Type } from "@fastify/type-provider-typebox";
import { bytesToHex } from "viem";

import { encodeAddress, Order, VmType } from "@relay-protocol/settlement-sdk";

import { getChainVmType } from "./chains";
import { externalError } from "./error";
import { AttestationService } from "../services/attestation";
import { orderSchema } from "../api/utils";

const encodeAddressToHex = (address: string, vmType: VmType) =>
  bytesToHex(encodeAddress(address, vmType));

export const recoverModeSchemaFields = {
  ownerSignature: Type.Optional(
    Type.String({
      description:
        "Owner signature authorizing the withdrawal (required when recoverMode is not set)",
    }),
  ),
  recoverMode: Type.Optional(
    Type.Boolean({
      description:
        "When true, skips owner signature verification and validates order against on-chain deposit instead",
    }),
  ),
  depositChainId: Type.Optional(
    Type.String({
      description:
        "Chain id of the deposit transaction (required for recoverMode)",
    }),
  ),
  depositTransactionId: Type.Optional(
    Type.String({
      description: "Transaction id of the deposit (required for recoverMode)",
    }),
  ),
  depositOnchainId: Type.Optional(
    Type.String({
      description: "Onchain id of the deposit (required for recoverMode)",
    }),
  ),
  order: Type.Optional(orderSchema),
  orderSignature: Type.Optional(
    Type.String({
      description:
        "The solver signature of the order (required for recoverMode)",
    }),
  ),
};

export async function validateRecoverMode(params: {
  attestationService: AttestationService;
  depositChainId?: string;
  depositTransactionId?: string;
  depositOnchainId?: string;
  order?: Order;
  orderSignature?: string;
  chainId: string;
  currency: string;
  amount: string;
  recipient: string;
  owner: string;
  ownerChainId: string;
}) {
  if (
    !params.depositChainId ||
    !params.depositTransactionId ||
    !params.depositOnchainId ||
    !params.order ||
    !params.orderSignature
  ) {
    throw externalError(
      "recoverMode requires depositChainId, depositTransactionId, depositOnchainId, order, and orderSignature",
    );
  }

  // Single-input only
  if (params.order.inputs.length !== 1) {
    throw externalError("recoverMode only supports single-input orders");
  }

  // Fetch deposit from chain
  const { messages: deposits } =
    await params.attestationService.attestDepositoryDeposits({
      chainId: params.depositChainId,
      transactionId: params.depositTransactionId,
    });
  const deposit = deposits.find(
    (d) => d.result.onchainId === params.depositOnchainId,
  );
  if (!deposit) {
    throw externalError(
      `Deposit with onchainId ${params.depositOnchainId} not found in transaction`,
    );
  }

  // Order ↔ on-chain deposit linkage + signature + no-fill-or-refund check
  await params.attestationService.validateOrderForDeposit({
    deposit,
    order: params.order,
    orderSignature: params.orderSignature,
  });

  // Match the refund entry that authorizes this withdrawal
  const refundVmType = await getChainVmType(params.chainId);
  const encodedCurrency = encodeAddressToHex(params.currency, refundVmType);
  const matches = params.order.inputs[0].refunds.filter(
    (r) =>
      r.chainId === params.chainId &&
      encodeAddressToHex(r.currency, refundVmType) === encodedCurrency,
  );
  if (matches.length !== 1) {
    throw externalError(
      `Expected exactly 1 refund entry for chain ${params.chainId} currency ${params.currency}, got ${matches.length}`,
    );
  }
  const refund = matches[0];

  if (
    encodeAddressToHex(params.recipient, refundVmType) !==
    encodeAddressToHex(refund.recipient, refundVmType)
  ) {
    throw externalError("Recipient does not match the order refund entry");
  }

  // Full-amount only
  if (BigInt(params.amount) !== BigInt(deposit.result.amount)) {
    throw externalError(
      "Amount does not match the deposit amount (slow refund is full-amount only)",
    );
  }

  // Owner / depositor cross-check
  if (params.ownerChainId !== params.depositChainId) {
    throw externalError("Owner chain does not match the deposit chain");
  }
  const ownerVmType = await getChainVmType(params.ownerChainId);
  if (
    encodeAddressToHex(params.owner, ownerVmType) !==
    encodeAddressToHex(deposit.result.depositor, ownerVmType)
  ) {
    throw externalError("Owner does not match the deposit's depositor");
  }
}

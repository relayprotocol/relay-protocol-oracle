import { Type } from "@fastify/type-provider-typebox";
import {
  normalizeWithdrawRequest,
  WithdrawRequest,
} from "@relay-protocol/settlement-sdk";

import {
  Endpoint,
  ErrorResponses,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
  getPeerResponses,
  withdrawRequestAdditionalDataSchema,
} from "../../utils";
import { getChain } from "../../../common/chains";
import { externalError } from "../../../common/error";
import { logger } from "../../../common/logger";
import {
  recoverModeSchemaFields,
  validateRecoverMode,
} from "../../../common/recover-mode-verification";
import { signAllocatorWithdrawRequest } from "../../../common/signer";
import { verifyOwnerSignature } from "../../../common/signature-verification";
import { AttestationService } from "../../../services/attestation";
import { config } from "../../../config";

const normalizedWithdrawRequestSchema = Type.Object({
  chainId: Type.String({ description: "The withdraw chain id" }),
  depository: Type.String({ description: "The encoded depository address" }),
  currency: Type.String({ description: "The encoded currency address" }),
  amount: Type.String({ description: "The withdrawal amount" }),
  spenderChainId: Type.String({ description: "The spender (owner) chain id" }),
  spender: Type.String({ description: "The encoded spender (owner) address" }),
  receiver: Type.String({ description: "The encoded recipient address" }),
  data: Type.String({ description: "The encoded withdrawal data" }),
  nonce: Type.String({ description: "Nonce for replay protection" }),
});

// Withdraw-chain vm types supported by this endpoint; reject anything else
// up front with a clean 4xx before owner-signature verification.
const SUPPORTED_WITHDRAW_VM_TYPES = [
  "bitcoin-vm",
  "ethereum-vm",
  "lighter-vm",
  "solana-vm",
  "ton-vm",
  "tron-vm",
];

const normalizedWithdrawRequestsEqual = (
  msg1?: WithdrawRequest,
  msg2?: WithdrawRequest,
) => {
  if (!msg1 || !msg2) {
    return false;
  }

  return (
    msg1.chainId === msg2.chainId &&
    msg1.depository === msg2.depository &&
    msg1.currency === msg2.currency &&
    msg1.amount === msg2.amount &&
    msg1.spenderChainId === msg2.spenderChainId &&
    msg1.spender === msg2.spender &&
    msg1.receiver === msg2.receiver &&
    msg1.data === msg2.data &&
    msg1.nonce === msg2.nonce
  );
};

const Schema = {
  body: Type.Object({
    chainId: Type.String({
      description: "The chain id to withdraw on",
    }),
    depository: Type.Optional(
      Type.String({
        description:
          "The depository to withdraw from (defaults to the chain's primary depository)",
      }),
    ),
    currency: Type.String({
      description: "The currency to withdraw",
    }),
    amount: Type.String({
      description: "The amount to withdraw",
    }),
    spenderChainId: Type.String({
      description: "The chain id of the spender",
    }),
    spender: Type.String({
      description: "The spender address",
    }),
    receiver: Type.String({
      description: "The withdrawal recipient",
    }),
    nonce: Type.String({
      description: "Nonce for replay protection",
      pattern: "^0x[0-9a-fA-F]{64}$",
    }),
    additionalData: Type.Optional(withdrawRequestAdditionalDataSchema),
    // ton-vm owners sign via TonConnect signData; echo back the wallet's
    // timestamp + domain so the oracle can reconstruct the signature.
    signatureMetadata: Type.Optional(
      Type.Object({
        "ton-vm": Type.Optional(
          Type.Object({
            timestamp: Type.Number({
              description: "Unix seconds from the TonConnect signData response",
            }),
            domain: Type.String({
              description: "Domain from the TonConnect signData response",
            }),
          }),
        ),
      }),
    ),
    ...recoverModeSchemaFields,
    requestPeerSignatures: Type.Optional(
      Type.Boolean({
        description:
          "Whether to request signatures from any configured oracle peers",
      }),
    ),
  }),
  response: {
    ...ErrorResponses,
    200: Type.Object({
      withdrawRequest: normalizedWithdrawRequestSchema,
      allocatorChainId: Type.Number({
        description: "The Hub EVM chain id of the allocator",
      }),
      allocatorContract: Type.String({
        description: "The allocator contract the signatures authorize",
      }),
      // Oracle signature(s) over the allocator WithdrawRequest digest. The
      // allocator's ORACLE is a threshold multisig, so the caller must sort
      // these by oracleSigner ascending and concatenate into one blob before
      // submitting on-chain.
      signatures: Type.Array(
        Type.Object({
          oracleSigner: Type.String({
            description: "The address of the oracle signer",
          }),
          signature: Type.String({
            description: "The signature over the WithdrawRequest digest",
          }),
        }),
        { minItems: 1 },
      ),
    }),
  },
};

export default {
  method: "POST",
  url: "/attestations/withdraw-request-authorization/v1",
  schema: Schema,
  handler: async (
    req: FastifyRequestTypeBox<typeof Schema>,
    reply: FastifyReplyTypeBox<typeof Schema>,
  ) => {
    const isRecoverMode = req.body.recoverMode === true;

    // Reject unsupported chains before verifying — clean 4xx, not a sig error.
    const chain = await getChain(req.body.chainId);
    if (!SUPPORTED_WITHDRAW_VM_TYPES.includes(chain.vmType)) {
      throw externalError(
        `Withdrawals on ${chain.vmType} are not supported by this endpoint`,
      );
    }

    // AUTHORIZE — the only per-branch difference. The shared tail below stays
    // identical so enabling recoverMode later only swaps this branch.
    if (isRecoverMode) {
      // Slow refund: skip user signature, validate the order against the
      // on-chain deposit + solver's no-fill-or-refund declaration instead.
      const attestationService = new AttestationService();
      await validateRecoverMode({
        attestationService,
        chainId: req.body.chainId,
        currency: req.body.currency,
        amount: req.body.amount,
        owner: req.body.spender,
        recipient: req.body.receiver,
        ownerChainId: req.body.spenderChainId,
        depositChainId: req.body.depositChainId,
        depositTransactionId: req.body.depositTransactionId,
        depositOnchainId: req.body.depositOnchainId,
        order: req.body.order,
        orderSignature: req.body.orderSignature,
      });
      // Audit log — recoverMode bypasses user signature; every accepted
      // invocation must be observable.
      logger.info(
        "recover-mode-verification",
        JSON.stringify({
          msg: "recoverMode attestation accepted",
          endpoint: "withdraw-request-authorization/v1",
          depositChainId: req.body.depositChainId,
          depositTransactionId: req.body.depositTransactionId,
          depositOnchainId: req.body.depositOnchainId,
          spender: req.body.spender,
          receiver: req.body.receiver,
          chainId: req.body.chainId,
        }),
      );
    } else {
      if (!req.body.ownerSignature) {
        throw externalError("ownerSignature is required");
      }
      // The user-signed digest keys on owner/recipient/ownerChainId (shared by
      // the other withdrawal endpoints); map the request fields onto it so the
      // digest stays identical across endpoints.
      await verifyOwnerSignature({
        data: {
          operation: "withdrawal",
          chainId: req.body.chainId,
          currency: req.body.currency,
          amount: req.body.amount,
          ownerChainId: req.body.spenderChainId,
          owner: req.body.spender,
          recipient: req.body.receiver,
          nonce: req.body.nonce,
          additionalData: req.body.additionalData,
          signatureMetadata: req.body.signatureMetadata,
        },
        signature: req.body.ownerSignature,
      });
    }

    // SHARED tail — build the canonical normalized request from the
    // user-signed params and sign its allocator digest with the oracle key.
    const spenderChain = await getChain(req.body.spenderChainId);

    const depository = req.body.depository ?? chain.depository!;
    const normalizedWithdrawRequest = normalizeWithdrawRequest({
      vmType: chain.vmType,
      spenderVmType: spenderChain.vmType,
      chainId: req.body.chainId,
      depository,
      currency: req.body.currency,
      amount: req.body.amount,
      spenderChainId: req.body.spenderChainId,
      spender: req.body.spender,
      receiver: req.body.receiver,
      nonce: req.body.nonce,
      additionalData: req.body.additionalData,
    });

    const { allocatorChainId, allocatorContract, oracleSigner, signature } =
      await signAllocatorWithdrawRequest(normalizedWithdrawRequest);

    const peerSignatures =
      req.body.requestPeerSignatures && config.peers
        ? await getPeerResponses({
            endpointPath: req.originalUrl,
            requestBody: req.body,
            requestApiKey: req.headers["x-api-key"],
            validateAndExtractResponse: (peerData: any) => {
              // Only accept peer signatures that authorize the SAME request and
              // allocator — a stale/misconfigured peer signing a different
              // digest would otherwise break multisig authorization on-chain.
              if (
                peerData.allocatorChainId !== allocatorChainId ||
                peerData.allocatorContract?.toLowerCase() !==
                  allocatorContract.toLowerCase() ||
                !normalizedWithdrawRequestsEqual(
                  peerData.withdrawRequest,
                  normalizedWithdrawRequest,
                )
              ) {
                return [];
              }
              return peerData.signatures ?? [];
            },
          })
        : [];

    return reply.send({
      withdrawRequest: normalizedWithdrawRequest,
      allocatorChainId,
      allocatorContract,
      signatures: [{ oracleSigner, signature }, ...peerSignatures],
    });
  },
} as Endpoint;

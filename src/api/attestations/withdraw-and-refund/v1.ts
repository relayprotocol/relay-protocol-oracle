import { Type } from "@fastify/type-provider-typebox";

import {
  areExecuteAndWithdrawRequestsEqual,
  areExecutionsEqual,
  Endpoint,
  ErrorResponses,
  executeAndWithdrawRequestSchema,
  executionSchema,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
  getPeerResponses,
  orderSchema,
} from "../../utils";
import {
  signExecuteAndWithdrawRequestMessage,
  signExecutionMessage,
} from "../../../common/signer";
import { config } from "../../../config";
import { AttestationService } from "../../../services/attestation";

const MessageData = Type.Object({
  chainId: Type.String({
    description: "The chain id of the transaction to attest",
  }),
  transactionId: Type.String({
    description: "The transaction id to attest",
  }),
  onchainId: Type.String({
    description: "The onchain id of the deposit",
  }),
  order: orderSchema,
  orderSignature: Type.String({
    description: "The solver signature of the order",
  }),
  nonce: Type.String({
    description: "Nonce to pass-through to the underlying withdraw request",
  }),
  hints: Type.Optional(
    Type.Object(
      {
        "ton-vm": Type.Optional(
          Type.Object({
            lt: Type.String({
              description:
                "The logical time of the deposit tx (required for ton-vm — TON has no global tx-hash lookup; high-throughput depositories make scan-fallback unreliable)",
            }),
          }),
        ),
      },
      { description: "Hints for attesting the deposit transaction" },
    ),
  ),
  requestPeerSignatures: Type.Optional(
    Type.Boolean({
      description:
        "Whether to request signatures from any configured oracle peers",
    }),
  ),
});

const Schema = {
  body: MessageData,
  response: {
    ...ErrorResponses,
    200: Type.Object({
      execution: executionSchema,
      executeAndWithdrawRequest: executeAndWithdrawRequestSchema,
    }),
  },
};

export default {
  method: "POST",
  url: "/attestations/withdraw-and-refund/v1",
  schema: Schema,
  handler: async (
    req: FastifyRequestTypeBox<typeof Schema>,
    reply: FastifyReplyTypeBox<typeof Schema>,
  ) => {
    const attestationService = new AttestationService();
    const { execution, executeAndWithdrawRequest } =
      await attestationService.attestWithdrawAndRefund(req.body);

    const peerResponses =
      req.body.requestPeerSignatures && config.peers
        ? await getPeerResponses({
            endpointPath: req.originalUrl,
            requestBody: req.body,
            requestApiKey: req.headers["x-api-key"],
            validateAndExtractResponse: (peerData: any) => {
              const executionSigner =
                peerData?.execution?.signatures?.[0]?.oracleSigner;
              const withdrawSigner =
                peerData?.executeAndWithdrawRequest?.signatures?.[0]
                  ?.oracleSigner;

              // Accept the peer only if both signed messages match ours AND
              // both carry a signature from the same oracle signer. The
              // multisig expects a consistent signer set across the execution
              // and executeAndWithdrawRequest messages, so a peer missing
              // either signature (or signing them with different signers) is
              // unusable and must be skipped.
              if (
                areExecutionsEqual(peerData.execution, execution) &&
                areExecuteAndWithdrawRequestsEqual(
                  peerData.executeAndWithdrawRequest,
                  executeAndWithdrawRequest,
                ) &&
                executionSigner &&
                withdrawSigner &&
                executionSigner.toLowerCase() === withdrawSigner.toLowerCase()
              ) {
                // This endpoint signs two messages, so collect the whole peer
                // payload (one entry per peer) and flatMap both signature
                // arrays below.
                return [peerData];
              }

              return [];
            },
            getSigner: (peerData: any) =>
              peerData?.execution?.signatures?.[0]?.oracleSigner,
          })
        : [];

    return reply.send({
      execution: {
        ...execution,
        signatures: [
          await signExecutionMessage(execution),
          ...peerResponses.flatMap(
            (peerResponse) => peerResponse.execution.signatures,
          ),
        ],
      },
      executeAndWithdrawRequest: {
        ...executeAndWithdrawRequest,
        signatures: [
          await signExecuteAndWithdrawRequestMessage(executeAndWithdrawRequest),
          ...peerResponses.flatMap(
            (peerResponse) => peerResponse.executeAndWithdrawRequest.signatures,
          ),
        ],
      },
    });
  },
} as Endpoint;

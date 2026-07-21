import { Type } from "@fastify/type-provider-typebox";

import {
  areExecutionsEqual,
  filterSignaturesByDomain,
  Endpoint,
  ErrorResponses,
  executionSchema,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
  getPeerResponses,
  orderSchema,
} from "../../utils";
import { signExecutionMessage } from "../../../common/signer";
import { config } from "../../../config";
import { AttestationService } from "../../../services/attestation";

const MessageData = Type.Object({
  order: orderSchema,
  orderSignature: Type.String({
    description: "The solver signature of the order",
  }),
  inputs: Type.Array(
    Type.Object({
      chainId: Type.Optional(
        Type.String({
          description:
            "The chain id of the deposit (only needed for forced attestations where the deposit was done on a different chain than the order's input)",
        }),
      ),
      transactionId: Type.String({
        description: "The transaction id of the deposit",
      }),
      onchainId: Type.String({
        description: "The onchain id of the deposit",
      }),
      inputIndex: Type.Number({
        description: "The index of the order input the deposit refers to",
      }),
    }),
  ),
  refunds: Type.Array(
    Type.Object({
      transactionId: Type.String({
        description: "The refund transaction",
      }),
      inputIndex: Type.Number({
        description: "The index of the order input",
      }),
      refundIndex: Type.Number({
        description: "The index of the order input refund",
      }),
    }),
  ),
  force: Type.Optional(
    Type.Boolean({
      description:
        "Force attestation even if the order solver fill is not valid",
    }),
  ),
  hints: Type.Optional(
    Type.Object(
      {
        "hyperliquid-vm": Type.Optional(
          Type.Object({
            user: Type.String({
              description: "The sender of the fill transaction",
            }),
            timestamp: Type.Number({
              description: "The timestamp of the fill transaction",
            }),
          }),
        ),
        "ton-vm": Type.Optional(
          Type.Object({
            solverAddress: Type.String({
              description:
                "The solver wallet that signed the refund (required — TON has no global tx-hash lookup)",
            }),
            lt: Type.Optional(
              Type.String({
                description:
                  "The logical time of the tx (optional but strongly preferred — enables O(1) lookup; without it attestor falls back to scanning recent txs and may miss older targets)",
              }),
            ),
          }),
        ),
      },
      { description: "Hints for attesting the fill transaction" },
    ),
  ),
  inputHints: Type.Optional(
    Type.Array(
      Type.Object({
        inputIndex: Type.Number({
          description: "The input index these hints apply to",
        }),
        "ton-vm": Type.Optional(
          Type.Object({
            lt: Type.String({
              description:
                "The logical time of the deposit tx (required for ton-vm deposit re-verification — TON has no global tx-hash lookup)",
            }),
          }),
        ),
      }),
      {
        description:
          "Per-input deposit attestation hints, looked up by `inputIndex`. Required for bridge-from-TON orders so the refund re-verification can locate the user's deposit tx.",
      },
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
      message: Type.Object(
        {
          data: MessageData,
          result: Type.Object({
            orderId: Type.String({
              description: "The id of the attested order",
            }),
            status: Type.Number({
              description:
                "The status of the solver refund (0 = failed, 1 = successful)",
            }),
            totalWeightedInputPaymentBpsDiff: Type.String({
              description:
                "The bps difference between the quoted amount and the deposited amount",
            }),
          }),
        },
        {
          description: "The resulting 'solver-refund' message",
        },
      ),
      execution: executionSchema,
    }),
  },
};

export default {
  method: "POST",
  url: "/attestations/solver-refunds/v1",
  schema: Schema,
  handler: async (
    req: FastifyRequestTypeBox<typeof Schema>,
    reply: FastifyReplyTypeBox<typeof Schema>,
  ) => {
    // Restrict the `force` option to only valid API keys
    if (req.body.force) {
      const apiKey = req.headers["x-api-key"] as string | undefined;
      if (!apiKey || !config.apiKeys || !config.apiKeys[apiKey]) {
        return reply
          .status(400)
          .send({ message: "Unauthorized to use the `force` option" });
      }
    }

    const attestationService = new AttestationService();
    const { message, execution } = await attestationService.attestSolverRefund(
      req.body,
    );

    const peerSignatures =
      req.body.requestPeerSignatures && config.peers
        ? await getPeerResponses({
            endpointPath: req.originalUrl,
            requestBody: req.body,
            requestApiKey: req.headers["x-api-key"],
            validateAndExtractResponse: (peerData: any) => {
              if (areExecutionsEqual(peerData.execution, execution)) {
                return peerData.execution.signatures;
              }

              return [];
            },
          })
        : [];

    const localExecutionSignature = execution
      ? await signExecutionMessage(execution)
      : undefined;

    return reply.send({
      message: {
        data: message.data,
        result: message.result,
      },
      execution:
        execution && localExecutionSignature
          ? {
              ...execution,
              signatures: [
                localExecutionSignature,
                ...filterSignaturesByDomain(
                  peerSignatures,
                  localExecutionSignature,
                  { chainId: "oracleChainId", contract: "oracleContract" },
                ),
              ],
            }
          : undefined,
    });
  },
} as Endpoint;

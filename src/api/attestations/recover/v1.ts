import { Type } from "@fastify/type-provider-typebox";

import {
  areExecutionsEqual,
  Endpoint,
  ErrorResponses,
  executionSchema,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
  getPeerResponses,
} from "../../utils";
import { signExecutionMessage } from "../../../common/signer";
import { config } from "../../../config";
import { AttestationService } from "../../../services/attestation";

const Schema = {
  body: Type.Object({
    chainId: Type.String({
      description: "The chain id of the deposit transaction",
    }),
    transactionId: Type.String({
      description: "The transaction id of the deposit",
    }),
    onchainId: Type.String({
      description: "The onchain id of the specific deposit to recover",
    }),
    order: Type.Optional(
      Type.Object(
        {
          version: Type.Literal("v1"),
          solverChainId: Type.String(),
          solver: Type.String(),
          salt: Type.String(),
          inputs: Type.Array(
            Type.Object({
              payment: Type.Object({
                chainId: Type.String(),
                currency: Type.String(),
                amount: Type.String(),
                weight: Type.String(),
              }),
              refunds: Type.Array(
                Type.Object({
                  chainId: Type.String(),
                  recipient: Type.String(),
                  currency: Type.String(),
                  minimumAmount: Type.String(),
                  deadline: Type.Number(),
                  extraData: Type.String(),
                }),
              ),
            }),
          ),
          output: Type.Object({
            chainId: Type.String(),
            payments: Type.Array(
              Type.Object({
                recipient: Type.String(),
                currency: Type.String(),
                minimumAmount: Type.String(),
                expectedAmount: Type.String(),
              }),
            ),
            calls: Type.Array(Type.String()),
            deadline: Type.Number(),
            extraData: Type.String(),
          }),
          fees: Type.Array(
            Type.Object({
              recipientChainId: Type.String(),
              recipient: Type.String(),
              currencyChainId: Type.String(),
              currency: Type.String(),
              amount: Type.String(),
            }),
          ),
        },
        {
          description:
            "The order data (required for deposits less than 7 days old)",
        },
      ),
    ),
    orderSignature: Type.Optional(
      Type.String({
        description:
          "The solver signature of the order (required when order is provided)",
      }),
    ),
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
      execution: executionSchema,
    }),
  },
};

export default {
  method: "POST",
  url: "/attestations/recover/v1",
  schema: Schema,
  handler: async (
    req: FastifyRequestTypeBox<typeof Schema>,
    reply: FastifyReplyTypeBox<typeof Schema>,
  ) => {
    const attestationService = new AttestationService();
    const { execution } = await attestationService.attestRecover(req.body);

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

    return reply.send({
      execution: {
        ...execution,
        signatures: [
          await signExecutionMessage(execution),
          ...peerSignatures,
        ],
      },
    });
  },
} as Endpoint;

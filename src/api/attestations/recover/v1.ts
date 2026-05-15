import { Type } from "@fastify/type-provider-typebox";

import {
  areExecutionsEqual,
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
    order: Type.Optional(orderSchema),
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

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
    hints: Type.Optional(
      Type.Object(
        {
          "ton-vm": Type.Optional(
            Type.Object({
              lt: Type.String({
                description:
                  "The logical time of the deposit tx (required for ton-vm — TON has no global tx-hash lookup)",
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

    const localExecutionSignature = await signExecutionMessage(execution);

    return reply.send({
      execution: {
        ...execution,
        signatures: [
          localExecutionSignature,
          ...filterSignaturesByDomain(peerSignatures, localExecutionSignature, {
            chainId: "oracleChainId",
            contract: "oracleContract",
          }),
        ],
      },
    });
  },
} as Endpoint;

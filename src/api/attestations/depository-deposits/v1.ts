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

const MessageData = Type.Object({
  chainId: Type.String({
    description: "The chain id of the transaction to attest",
  }),
  transactionId: Type.String({
    description: "The transaction id to attest",
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
      messages: Type.Array(
        Type.Object({
          data: MessageData,
          result: Type.Object({
            onchainId: Type.String({
              description: "The onchain id of the deposit",
            }),
            depository: Type.String({
              description: "The depository address for the deposit",
            }),
            depositId: Type.Optional(
              Type.String({ description: "The id associated to the deposit" }),
            ),
            depositor: Type.String({
              description: "The address of the depositor",
            }),
            currency: Type.String({
              description: "The address of the deposited currency",
            }),
            amount: Type.String({ description: "The deposited amount" }),
          }),
          extraData: Type.Optional(
            Type.Object({
              timestamp: Type.String({
                description:
                  "The block timestamp of the deposit (epoch seconds)",
              }),
            }),
          ),
        }),
        {
          description:
            "A list of 'depository-deposit' messages that occured in the requested transaction",
        },
      ),
      execution: executionSchema,
    }),
  },
};

export default {
  method: "POST",
  url: "/attestations/depository-deposits/v1",
  schema: Schema,
  handler: async (
    req: FastifyRequestTypeBox<typeof Schema>,
    reply: FastifyReplyTypeBox<typeof Schema>,
  ) => {
    const attestationService = new AttestationService();
    const { messages, execution } =
      await attestationService.attestDepositoryDeposits(req.body);

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
      messages,
      execution: execution
        ? {
            ...execution,
            signatures: [
              await signExecutionMessage(execution),
              ...peerSignatures,
            ],
          }
        : undefined,
    });
  },
} as Endpoint;

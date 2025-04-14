import { Type } from "@fastify/type-provider-typebox";

import {
  Endpoint,
  ErrorResponses,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
} from "../../utils";
import { getAttestationService } from "../../../services";

const Schema = {
  body: Type.Object({
    chainId: Type.Number({
      description: "The chain id of the transaction to attest",
    }),
    transactionId: Type.String({
      description: "The transaction id to attest",
    }),
  }),
  response: {
    ...ErrorResponses,
    200: Type.Object({
      messages: Type.Array(
        Type.Object({
          kind: Type.Literal("escrow-deposit"),
          messageId: Type.String({ description: "The id of the message" }),
          input: Type.Object({
            chainId: Type.Number({
              description: "The chain id of the attested transaction",
            }),
            transactionId: Type.String({
              description: "The id of the attested transaction",
            }),
          }),
          output: Type.Object({
            escrow: Type.String({
              description: "The escrow address the deposit occured on",
            }),
            depositor: Type.String({
              description: "The address of the depositor",
            }),
            currency: Type.String({
              description: "The address of the deposited currency",
            }),
            amount: Type.String({ description: "The deposited amount" }),
            id: Type.Optional(
              Type.String({ description: "The id associated to the deposit" })
            ),
          }),
        }),
        {
          description:
            "A list of 'escrow-deposit' messages that occured in the requested transaction",
        }
      ),
    }),
  },
};

export default {
  method: "POST",
  url: "/attestations/escrow-deposits/v1",
  schema: Schema,
  handler: async (
    req: FastifyRequestTypeBox<typeof Schema>,
    reply: FastifyReplyTypeBox<typeof Schema>
  ) => {
    const attestationService = await getAttestationService(req.body.chainId);
    const messages = await attestationService.attestEscrowDeposits({
      chainId: req.body.chainId,
      transactionId: req.body.transactionId,
    });

    return reply.send({ messages });
  },
} as Endpoint;

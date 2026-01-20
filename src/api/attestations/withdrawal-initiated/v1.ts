import { Type } from "@fastify/type-provider-typebox";

import {
  Endpoint,
  ErrorResponses,
  executionSchema,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
  WithdrawalAddressSchema,
} from "../../utils";
import { AttestationService } from "../../../services/attestation";

const MessageData = Type.Object({
  settlementChainId: Type.String({
    description: "The chain id of the hub",
  }),
  expectedAmount: Type.String({
    description: "The expected balance held by the withdrawal address",
  }),
  ...WithdrawalAddressSchema.properties,
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
            proofOfWithdrawalAddressBalance: Type.String({
              description: "The proof of the withdrawal address balance",
            }),
            withdrawalAddress: Type.String({
              description: "The withdrawal address",
            }),
          }),
        },
        {
          description: "The resulting 'withdrawal-initiate' message",
        },
      ),
      execution: executionSchema,
    }),
  },
};

export default {
  method: "POST",
  url: "/attestations/withdrawal-initiated/v1",
  schema: Schema,
  handler: async (
    req: FastifyRequestTypeBox<typeof Schema>,
    reply: FastifyReplyTypeBox<typeof Schema>,
  ) => {
    const attestationService = new AttestationService();
    const { message } = await attestationService.attestWithdrawalAddressBalance(
      req.body,
    );
    return reply.send({
      message: {
        data: message.data,
        result: message.result,
      },
    });
  },
} as Endpoint;

import { Type } from "@fastify/type-provider-typebox";

import {
  Endpoint,
  ErrorResponses,
  executionSchema,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
  WithdrawalAddressSchema,
} from "../../utils";
import { signExecutionMessageForChain } from "../../../common/signer";
import { AttestationService } from "../../../services/attestation";

const MessageData = Type.Object({
  settlementChainId: Type.String({
    description: "The chain id of the hub",
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
            withdrawalAddress: Type.String({
              description: "The address of the withdrawal",
            }),
          }),
        },
        {
          description:
            "The withdrawal address corresponding to the withdrawal initiated by the user.",
        }
      ),
      execution: executionSchema,
    }),
  },
};

export default {
  method: "POST",
  url: "/attestations/withdrawal-initiation/v1",
  schema: Schema,
  handler: async (
    req: FastifyRequestTypeBox<typeof Schema>,
    reply: FastifyReplyTypeBox<typeof Schema>
  ) => {
    const attestationService = new AttestationService();
    const { message, execution } =
      await attestationService.attestWithdrawalOwnerBalance(req.body);

    return reply.send({
      message: {
        data: message.data,
        result: message.result,
      },
      execution: execution
        ? {
            ...execution,
            signatures: [
              await signExecutionMessageForChain(
                execution,
                req.body.settlementChainId
              ),
            ],
          }
        : undefined,
    });
  },
} as Endpoint;

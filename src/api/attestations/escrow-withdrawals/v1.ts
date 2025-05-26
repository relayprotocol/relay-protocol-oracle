import { Type } from "@fastify/type-provider-typebox";
import { EscrowWithdrawalStatus } from "@reservoir0x/relay-protocol-sdk";

import {
  Endpoint,
  ErrorResponses,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
} from "../../utils";
import { signEscrowWithdrawalMessage } from "../../../common/signer";
import { AttestationService } from "../../../services/attestation";

const MessageData = Type.Object({
  chainId: Type.String({
    description: "The chain id of the withdrawal to attest",
  }),
  withdrawal: Type.String({
    description: "The withdrawal to attest",
  }),
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
            withdrawalId: Type.String({
              description: "The id of the attested withdrawal",
            }),
            escrow: Type.String({
              description: "The escrow address for the withdrawal",
            }),
            status: Type.Union(
              [
                Type.Literal("executed"),
                Type.Literal("expired"),
                Type.Literal("pending"),
              ],
              {
                description: "The status of the withdrawal",
              }
            ),
          }),
          signature: Type.Object({
            oracle: Type.String({
              description: "The address of the signing oracle",
            }),
            signature: Type.String({
              description: "The message signature",
            }),
          }),
        },
        {
          description: "The resulting 'escrow-withdrawal' message",
        }
      ),
    }),
  },
};

export default {
  method: "POST",
  url: "/attestations/escrow-withdrawals/v1",
  schema: Schema,
  handler: async (
    req: FastifyRequestTypeBox<typeof Schema>,
    reply: FastifyReplyTypeBox<typeof Schema>
  ) => {
    const attestationService = new AttestationService();
    const message = await attestationService.attestEscrowWithdrawal(req.body);

    return reply.send({
      message: {
        ...message,
        result: {
          ...message.result,
          status:
            message.result.status === EscrowWithdrawalStatus.PENDING
              ? "pending"
              : message.result.status === EscrowWithdrawalStatus.EXECUTED
              ? "executed"
              : "expired",
        },
        signature: await signEscrowWithdrawalMessage(message),
      },
    });
  },
} as Endpoint;

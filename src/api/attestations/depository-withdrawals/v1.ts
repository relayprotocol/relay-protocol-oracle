import { Type } from "@fastify/type-provider-typebox";
import axios from "axios";

import {
  areExecutionsEqual,
  Endpoint,
  ErrorResponses,
  executionSchema,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
  messageSignatureSchema,
  WithdrawalAddressSchema,
} from "../../utils";
import {
  signDepositoryWithdrawalMessage,
  signExecutionMessage,
} from "../../../common/signer";
import { config } from "../../../config";
import { AttestationService } from "../../../services/attestation";

const MessageData = Type.Object({
  chainId: Type.String({
    description: "The chain id of the withdrawal to attest",
  }),
  withdrawal: Type.String({
    description: "The withdrawal to attest",
  }),
  transactionId: Type.Optional(
    Type.String({
      description:
        "The transaction id that executed the withdrawal (required for Hyperliquid VM)",
    }),
  ),
  withdrawalAddressRequest: Type.Optional(WithdrawalAddressSchema),
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
            withdrawalId: Type.String({
              description: "The id of the attested withdrawal",
            }),
            depository: Type.String({
              description: "The depository address for the withdrawal",
            }),
            status: Type.Number({
              description:
                "The status of the withdrawal (0 = pending, 1 = executed, 2 = expired)",
            }),
          }),
          signature: messageSignatureSchema,
        },
        {
          description: "The resulting 'depository-withdrawal' message",
        },
      ),
      execution: executionSchema,
    }),
  },
};

export default {
  method: "POST",
  url: "/attestations/depository-withdrawals/v1",
  schema: Schema,
  handler: async (
    req: FastifyRequestTypeBox<typeof Schema>,
    reply: FastifyReplyTypeBox<typeof Schema>,
  ) => {
    const attestationService = new AttestationService();
    const { message, execution } =
      await attestationService.attestDepositoryWithdrawal(req.body);

    // TODO: Fix the types
    const peerSignatures: any[] = [];
    if (execution && req.body.requestPeerSignatures && config.peers) {
      await Promise.all(
        Object.entries(config.peers).map(async ([url, apiKey]) => {
          const response = await axios.post(
            `${url}/attestations/depository-withdrawals/v1`,
            {
              ...req.body,
              requestPeerSignatures: false,
            },
            {
              headers: {
                "x-api-key":
                  apiKey === "pass-through" ? req.headers["x-api-key"] : apiKey,
              },
            },
          );

          // Only consider the peer signature if the executions are equal
          if (areExecutionsEqual(response.data.execution, execution)) {
            peerSignatures.push(...response.data.execution.signatures);
          }
        }),
      );
    }

    return reply.send({
      message: {
        data: {
          ...message.data,
          withdrawalAddressRequest: req.body.withdrawalAddressRequest,
        },
        result: message.result,
        signature: await signDepositoryWithdrawalMessage(message),
      },
      execution: execution
        ? {
            ...execution,
            signatures: [
              ...(await signExecutionMessage(execution)),
              ...peerSignatures,
            ],
          }
        : undefined,
    });
  },
} as Endpoint;

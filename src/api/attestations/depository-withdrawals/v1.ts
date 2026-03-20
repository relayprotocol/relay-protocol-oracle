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
  withdrawalAddressRequest: Type.Object({
    chainId: Type.String({
      description:
        "The hub chain id of the depository contract currently holding the funds",
    }),
    currency: Type.String({
      description:
        "The id of the currency as expressed on origin chain (string)",
    }),
    withdrawer: Type.String({
      description: "The address that is requiring the withdrawal",
    }),
    withdrawerChainId: Type.String({
      description:
        "The chain id of the address that is requiring the withdrawal",
    }),
    recipient: Type.String({
      description:
        "The address that will receive the withdrawn funds on destination chain",
    }),
    withdrawalNonce: Type.String({
      description:
        "Optional nonce to prevent collisions for similar withdrawals in the same block",
    }),
  }),
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
      message: {
        data: {
          ...message.data,
          withdrawalAddressRequest: req.body.withdrawalAddressRequest,
        },
        result: message.result,
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

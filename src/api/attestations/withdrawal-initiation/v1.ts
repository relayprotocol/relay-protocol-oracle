import { Type } from "@fastify/type-provider-typebox";
import axios from "axios";

import {
  areExecutionsEqual,
  Endpoint,
  ErrorResponses,
  executionSchema,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
  WithdrawalAddressSchema,
} from "../../utils";
import { signExecutionMessageForChain } from "../../../common/signer";
import { config } from "../../../config";
import { AttestationService } from "../../../services/attestation";

const MessageData = Type.Object({
  settlementChainId: Type.String({
    description: "The chain id of the hub",
  }),
  expectedAmount: Type.String({
    description: "The balance expected for withdrawer address",
  }),
  signature: Type.String({
    description:
      "The signed sha256 hash of withdrawerAlias + amount + nonce to authentificate the account that triggers the withdrawal",
  }),
  ...WithdrawalAddressSchema.properties,
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
            withdrawalAddress: Type.String({
              description: "The address of the withdrawal",
            }),
          }),
        },
        {
          description:
            "The withdrawal address corresponding to the withdrawal initiated by the user",
        },
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
    reply: FastifyReplyTypeBox<typeof Schema>,
  ) => {
    const attestationService = new AttestationService();
    const { message, execution } =
      await attestationService.attestWithdrawerBalance(req.body);

    // TODO: Fix the types
    const peerSignatures: any[] = [];
    if (execution && req.body.requestPeerSignatures && config.peers) {
      await Promise.all(
        Object.entries(config.peers).map(async ([url, apiKey]) => {
          const response = await axios.post(
            `${url}/attestations/withdrawal-initiation/v1`,
            {
              ...req.body,
              requestPeerSignatures: false,
            },
            {
              headers: {
                "x-api-key": apiKey,
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
        data: message.data,
        result: message.result,
      },
      execution: execution
        ? {
            ...execution,
            signatures: [
              await signExecutionMessageForChain(
                execution,
                req.body.settlementChainId,
              ),
              ...peerSignatures,
            ],
          }
        : undefined,
    });
  },
} as Endpoint;

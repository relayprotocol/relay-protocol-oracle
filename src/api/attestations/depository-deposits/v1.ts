import { Type } from "@fastify/type-provider-typebox";
import axios from "axios";

import {
  Endpoint,
  ErrorResponses,
  executionSchema,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
  signatureSchema,
} from "../../utils";
import {
  signDepositoryDepositMessage,
  signExecutionMessage,
} from "../../../common/signer";
import { config } from "../../../config";
import { AttestationService } from "../../../services/attestation";

const MessageData = Type.Object({
  chainId: Type.String({
    description: "The chain id of the transaction to attest",
  }),
  transactionId: Type.String({
    description: "The transaction id to attest",
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
          signature: signatureSchema,
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

    // TODO: Fix the types
    const peerSignatures: any[] = [];
    if (req.body.requestPeerSignatures && config.peers) {
      await Promise.all(
        Object.entries(config.peers).map(async ([url, apiKey]) => {
          const response = await axios.post(
            `${url}/attestations/depository-deposits/v1`,
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
          peerSignatures.push(...response.data.execution.signatures);
        }),
      );
    }

    return reply.send({
      messages: await Promise.all(
        messages.map(async (message) => ({
          ...message,
          signature: await signDepositoryDepositMessage(message),
        })),
      ),
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

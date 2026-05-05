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
import { getChain } from "../../../common/chains";
import { signExecutionMessage } from "../../../common/signer";
import { config } from "../../../config";
import { AttestationService } from "../../../services/attestation";

const MessageData = Type.Object({
  chainId: Type.String({
    description: "The chain id to withdraw on",
  }),
  currency: Type.String({
    description: "The currency to withdraw",
  }),
  amount: Type.String({
    description: "The amount to withdraw",
  }),
  spenderChainId: Type.String({
    description: "The chain id of the funds owner",
  }),
  spender: Type.String({
    description: "The owner of the funds",
  }),
  receiver: Type.String({
    description: "The withdrawal recipient",
  }),
  nonce: Type.String({
    description: "Nonce for replay protection",
  }),
  requestPeerSignatures: Type.Optional(
    Type.Boolean({
      description:
        "Whether to request signatures from any configured oracle peers",
    }),
  ),
  transactionId: Type.Optional(
    Type.String({
      description:
        "The transaction id that executed the withdrawal (required for Hyperliquid VM)",
    }),
  ),
});

const Schema = {
  body: MessageData,
  response: {
    ...ErrorResponses,
    200: Type.Object({
      status: Type.Number({
        description:
          "The status of the withdrawal (0 = pending, 1 = executed, 2 = expired)",
      }),
      execution: executionSchema,
    }),
  },
};

export default {
  method: "POST",
  url: "/attestations/depository-withdrawals/v3",
  schema: Schema,
  handler: async (
    req: FastifyRequestTypeBox<typeof Schema>,
    reply: FastifyReplyTypeBox<typeof Schema>,
  ) => {
    const chain = await getChain(req.body.chainId);

    const attestationService = new AttestationService();
    const { status, execution } =
      await attestationService.attestDepositoryWithdrawalV3({
        chainId: req.body.chainId,
        depository: chain.depository!,
        currency: req.body.currency,
        amount: req.body.amount,
        spenderChainId: req.body.spenderChainId,
        spender: req.body.spender,
        receiver: req.body.receiver,
        nonce: req.body.nonce,
        transactionId: req.body.transactionId,
      });

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
      status,
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

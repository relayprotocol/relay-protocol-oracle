import { Type } from "@fastify/type-provider-typebox";

import {
  Endpoint,
  ErrorResponses,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
} from "../../utils";
import { signSolverFillMessage } from "../../../common/signer";
import { config } from "../../../config";
import { AttestationService } from "../../../services/attestation";

const MessageData = Type.Object({
  order: Type.Object(
    {
      version: Type.Literal("v1"),
      solverChainId: Type.String(),
      solver: Type.String(),
      salt: Type.String(),
      inputs: Type.Array(
        Type.Object({
          payment: Type.Object({
            chainId: Type.String(),
            currency: Type.String(),
            amount: Type.String(),
            weight: Type.String(),
          }),
          refunds: Type.Array(
            Type.Object({
              chainId: Type.String(),
              recipient: Type.String(),
              currency: Type.String(),
              minimumAmount: Type.String(),
              deadline: Type.Number(),
              extraData: Type.String(),
            })
          ),
        })
      ),
      output: Type.Object({
        chainId: Type.String(),
        payments: Type.Array(
          Type.Object({
            recipient: Type.String(),
            currency: Type.String(),
            minimumAmount: Type.String(),
            expectedAmount: Type.String(),
          })
        ),
        calls: Type.Array(Type.String()),
        deadline: Type.Number(),
        extraData: Type.String(),
      }),
      fees: Type.Array(
        Type.Object({
          recipientChainId: Type.String(),
          recipient: Type.String(),
          currencyChainId: Type.String(),
          currency: Type.String(),
          amount: Type.String(),
        })
      ),
    },
    {
      description: "The order data",
    }
  ),
  orderSignature: Type.String({
    description: "The solver signature of the order",
  }),
  inputs: Type.Array(
    Type.Object({
      transactionId: Type.String({
        description: "The transaction id of the deposit",
      }),
      onchainId: Type.String({
        description: "The onchain id of the deposit",
      }),
      inputIndex: Type.Number({
        description: "The index of the order input the deposit refers to",
      }),
    })
  ),
  fill: Type.Object({
    transactionId: Type.String({
      description: "The fill transaction",
    }),
  }),
  force: Type.Optional(
    Type.Boolean({
      description:
        "Force attestation even if the order solver fill is not valid",
    })
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
            orderId: Type.String({
              description: "The id of the attested order",
            }),
            status: Type.Number({
              description:
                "The status of the solver fill (0 = failed, 1 = successful)",
            }),
            totalWeightedInputPaymentBpsDiff: Type.String({
              description:
                "The bps difference between the quoted amount and the deposited amount",
            }),
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
          description: "The resulting 'solver-fill' message",
        }
      ),
    }),
  },
};

export default {
  method: "POST",
  url: "/attestations/solver-fills/v1",
  schema: Schema,
  handler: async (
    req: FastifyRequestTypeBox<typeof Schema>,
    reply: FastifyReplyTypeBox<typeof Schema>
  ) => {
    const attestationService = new AttestationService();
    const message = await attestationService.attestSolverFill(req.body);

    // Restrict the `force` option to specific integrators
    if (req.body.force) {
      const apiKey = req.headers["x-api-key"] as string | undefined;
      if (!apiKey || !config.apiKeys || !config.apiKeys[apiKey]) {
        return reply
          .status(400)
          .send({ message: "Unauthorized to use the `force` option" });
      }
    }

    return reply.send({
      message: {
        data: message.data,
        result: message.result,
        signature: await signSolverFillMessage(message),
      },
    });
  },
} as Endpoint;

import { Type } from "@fastify/type-provider-typebox";
import { SolverFillStatus } from "@reservoir0x/relay-protocol-sdk";

import {
  Endpoint,
  ErrorResponses,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
} from "../../utils";
import { AttestationService } from "../../../services/attestation";

const MessageData = Type.Object({
  order: Type.Object(
    {
      solver: Type.Object({
        chainId: Type.Number(),
        address: Type.String(),
      }),
      salt: Type.String(),
      inputs: Type.Array(
        Type.Object({
          payment: Type.Object({
            chainId: Type.Number(),
            currency: Type.String(),
            amount: Type.String(),
            weight: Type.String(),
          }),
          refunds: Type.Array(
            Type.Object({
              chainId: Type.Number(),
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
        chainId: Type.Number(),
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
          recipientChainId: Type.Number(),
          recipient: Type.String(),
          currencyChainId: Type.Number(),
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
            status: Type.Union(
              [Type.Literal("failed"), Type.Literal("successful")],
              {
                description: "The status of the solver fill",
              }
            ),
            totalWeightedInputPaymentBpsDiff: Type.String({
              description:
                "The bps difference between the quoted amount and the deposited amount",
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
  url: "/attestations/solver-fill/v1",
  schema: Schema,
  handler: async (
    req: FastifyRequestTypeBox<typeof Schema>,
    reply: FastifyReplyTypeBox<typeof Schema>
  ) => {
    const attestationService = new AttestationService();
    const message = await attestationService.attestSolverFill(req.body);

    return reply.send({
      message: {
        ...message,
        result: {
          ...message.result,
          status:
            message.result.status === SolverFillStatus.FAILED
              ? "failed"
              : "successful",
        },
      },
    });
  },
} as Endpoint;

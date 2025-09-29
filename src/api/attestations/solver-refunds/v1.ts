import { Type } from "@fastify/type-provider-typebox";

import {
  Endpoint,
  ErrorResponses,
  executionSchema,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
  signatureSchema,
} from "../../utils";
import {
  signExecutionMessage,
  signSolverRefundMessage,
} from "../../../common/signer";
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
  refunds: Type.Array(
    Type.Object({
      transactionId: Type.String({
        description: "The refund transaction",
      }),
      inputIndex: Type.Number({
        description: "The index of the order input",
      }),
      refundIndex: Type.Number({
        description: "The index of the order input refund",
      }),
    })
  ),
  force: Type.Optional(
    Type.Boolean({
      description:
        "Force attestation even if the order solver fill is not valid",
    })
  ),
  includeOnchainHubExecution: Type.Optional(
    Type.Boolean({
      description:
        "Whether to include an execution message for the onchain Hub",
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
                "The status of the solver refund (0 = failed, 1 = successful)",
            }),
            totalWeightedInputPaymentBpsDiff: Type.String({
              description:
                "The bps difference between the quoted amount and the deposited amount",
            }),
          }),
          signature: signatureSchema,
        },
        {
          description: "The resulting 'solver-refund' message",
        }
      ),
      execution: executionSchema,
    }),
  },
};

export default {
  method: "POST",
  url: "/attestations/solver-refunds/v1",
  schema: Schema,
  handler: async (
    req: FastifyRequestTypeBox<typeof Schema>,
    reply: FastifyReplyTypeBox<typeof Schema>
  ) => {
    const attestationService = new AttestationService();
    const { message, execution } = await attestationService.attestSolverRefund(
      req.body
    );

    // Restrict the `force` option to specific integrators
    if (req.body.force) {
      const apiKey = req.headers["x-api-key"] as string | undefined;
      if (
        !apiKey ||
        !config.apiKeys ||
        !config.apiKeys[apiKey] ||
        config.apiKeys[apiKey] !== "relay"
      ) {
        return reply
          .status(400)
          .send({ message: "Unauthorized to use the `force` option" });
      }
    }

    return reply.send({
      message: {
        data: message.data,
        result: message.result,
        signature: await signSolverRefundMessage(message),
      },
      execution: execution
        ? {
            ...execution,
            signature: await signExecutionMessage(execution),
          }
        : undefined,
    });
  },
} as Endpoint;

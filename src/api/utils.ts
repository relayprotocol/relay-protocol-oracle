import { Type, type TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type {
  ContextConfigDefault,
  FastifyReply,
  FastifyRequest,
  HTTPMethods,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import type { RouteGenericInterface } from "fastify/types/route";
import type { FastifySchema } from "fastify/types/schema";

import { isExternalError } from "../common/error";
import { logger } from "../common/logger";

export type FastifyRequestTypeBox<TSchema extends FastifySchema> =
  FastifyRequest<
    RouteGenericInterface,
    RawServerDefault,
    RawRequestDefaultExpression,
    TSchema,
    TypeBoxTypeProvider
  >;

export type FastifyReplyTypeBox<TSchema extends FastifySchema> = FastifyReply<
  RouteGenericInterface,
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  ContextConfigDefault,
  TSchema,
  TypeBoxTypeProvider
>;

export type Endpoint = {
  url: string;
  method: HTTPMethods;
  schema: FastifySchema;
  handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
};

export const ErrorResponses = {
  400: Type.Object({
    message: Type.String({ description: "Error message" }),
  }),
};

// Generic wrapper for standard error handling across all endpoints
export const errorWrapper = (
  url: string,
  handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
): ((req: FastifyRequest, reply: FastifyReply) => Promise<void>) => {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await handler(req, reply);
    } catch (error) {
      // External errors can be passed-through externally
      if (isExternalError(error)) {
        return reply.status(400).send({ message: error.message });
      }

      logger.error(
        url,
        JSON.stringify({
          msg: "Request failed",
          requestUrl: req.url,
          requestBody: req.body,
          error,
          errorMsg: error.msg,
          errorResponse: error.response?.data ?? error.response?.body,
          errorStack: error.stack,
        })
      );

      throw new Error("Something went wrong");
    }
  };
};

// Shared schemas

// BigInt is serialized as string in JSON, but TypeBox doesn't have a native BigInt type
// This creates a custom type that tells TypeScript to expect bigint while serializing as string
export const BigIntString = Type.Unsafe<bigint>({ type: "string" });

export const signatureSchema = Type.Object({
  oracle: Type.String({
    description: "The address of the signing oracle",
  }),
  signature: Type.String({
    description: "The message signature",
  }),
});

// Signature for the Hub execution
export const hubExecutionSignatureSchema = Type.Object({
  oracleChainId: BigIntString,
  oracleContract: Type.String({
    description: "The address of the oracle contract on the hub chain",
  }),
  oracleSigner: Type.String({
    description: "The address of the oracle signer",
  }),
  signature: Type.String({
    description: "The message signature",
  }),
});

export const executionSchema = Type.Optional(
  Type.Object(
    {
      idempotencyKey: Type.String(),
      actions: Type.Array(Type.String(), { minItems: 1 }),
      metadata: Type.Optional(
        Type.Array(
          Type.Object({
            hubTokenId: BigIntString,
            origin: Type.Object({
              address: Type.String(),
              chainId: BigIntString,
              family: Type.String(),
            }),
            oracleChainId: Type.String(),
            oracleContract: Type.String({
              description:
                "The address of the oracle contract on the hub chain",
            }),
          })
        )
      ),
      signatures: Type.Array(hubExecutionSignatureSchema, { minItems: 1 }),
    },
    {
      description: "The 'execution' message to be relayed on the Hub",
    }
  )
);

// fastify schema for the params needed to create a withdrawal address
export const WithdrawalAddressSchema = Type.Object({
  depositoryAddress: Type.String({
    description: "The depository contract holding the funds on origin chain",
  }),
  depositoryChainSlug: Type.String({
    description:
      "The hub chain id of the depository contract currently holding the funds",
  }),
  currency: Type.String({
    description: "The id of the currency as expressed on origin chain (string)",
  }),
  owner: Type.String({
    description: "The address that originally owns the funds",
  }),
  ownerChainId: Type.String({
    description: "The chain id where the address originally owns the funds",
  }),
  recipientAddress: Type.String({
    description:
      "The address that will receive the withdrawn funds on destination chain",
  }),
  amount: Type.String({
    description: "The balance to withdraw",
  }),
  withdrawalNonce: Type.String({
    description:
      "Optional nonce to prevent collisions for similar withdrawals in the same block",
  }),
});

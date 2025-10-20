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
          })
        )
      ),
      signature: signatureSchema,
    },
    {
      description: "The 'execution' message to be relayed on the Hub",
    }
  )
);

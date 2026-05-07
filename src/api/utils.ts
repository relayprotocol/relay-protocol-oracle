import { Type, type TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import {
  ExecutionMessage,
  GenericMappingMessage,
  SubmitWithdrawRequest,
} from "@relay-protocol/settlement-sdk";
import axios from "axios";
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
import { config } from "../config";

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
  handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>,
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
          error,
          errorMsg: error.msg,
          errorResponse: error.response?.data ?? error.response?.body,
          errorStack: error.stack,
        }),
      );

      throw new Error("Something went wrong");
    }
  };
};

// Shared schemas

// BigInt is serialized as string in JSON, but TypeBox doesn't have a native BigInt type
// This creates a custom type that tells TypeScript to expect bigint while serializing as string
export const BigIntString = Type.Unsafe<bigint>({ type: "string" });

export const executionMessageSignatureSchema = Type.Object({
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
              chainId: Type.String(),
              family: Type.String(),
            }),
            oracleChainId: Type.String(),
            oracleContract: Type.String({
              description:
                "The address of the oracle contract on the hub chain",
            }),
          }),
        ),
      ),
      signatures: Type.Array(executionMessageSignatureSchema, { minItems: 1 }),
    },
    {
      description: "The 'execution' message to be relayed on the Hub",
    },
  ),
);

// Utility for comparing two execution messages
export const areExecutionsEqual = (
  msg1?: ExecutionMessage,
  msg2?: ExecutionMessage,
) => {
  if (!msg1 || !msg2) {
    return false;
  }

  return (
    msg1.idempotencyKey === msg2.idempotencyKey &&
    msg1.actions.length === msg2.actions.length &&
    msg1.actions.every((_, i) => msg1.actions[i] === msg2.actions[i])
  );
};

// Utility for comparing two payload params (ignoring signatures)
export const arePayloadParamsEqual = (
  msg1?: SubmitWithdrawRequest,
  msg2?: SubmitWithdrawRequest,
) => {
  if (!msg1 || !msg2) {
    return false;
  }

  return (
    msg1.chainId === msg2.chainId &&
    msg1.depository === msg2.depository &&
    msg1.currency === msg2.currency &&
    msg1.amount === msg2.amount &&
    msg1.spender === msg2.spender &&
    msg1.recipient === msg2.recipient &&
    msg1.nonce === msg2.nonce &&
    msg1.data === msg2.data
  );
};

// Utility for comparing two generic mappings (ignoring signatures)
export const areGenericMappingsEqual = (
  msg1?: GenericMappingMessage,
  msg2?: GenericMappingMessage,
) => {
  if (!msg1 || !msg2) {
    return false;
  }

  return (
    msg1.user === msg2.user &&
    msg1.id === msg2.id &&
    msg1.data === msg2.data &&
    msg1.nonce === msg2.nonce
  );
};

/** Fan out the same attestation request to peer oracles and collect only
 * signatures whose execution payload matches the local execution. Failures and
 * timeouts are logged and skipped so one unhealthy peer does not fail the
 * entire request path.
 */
export const getPeerResponses = async ({
  endpointPath,
  requestBody,
  requestApiKey,
  validateAndExtractResponse,
}: {
  endpointPath: string;
  requestBody: Record<string, unknown>;
  requestApiKey?: string | string[];
  validateAndExtractResponse: (peerData: any) => any[];
}) => {
  if (!config.peers) {
    return [];
  }

  const peerResponses = await Promise.all(
    Object.entries(config.peers).map(async ([url, apiKey]) => {
      const start = Date.now();
      try {
        const response = await axios.post(
          `${url}${endpointPath}`,
          {
            ...requestBody,
            requestPeerSignatures: false,
          },
          {
            headers: {
              "x-api-key": apiKey === "pass-through" ? requestApiKey : apiKey,
            },
            timeout: config.peerRequestTimeoutMs,
          },
        );

        const durationMs = Date.now() - start;
        const logLevel = durationMs > 5000 ? "warn" : "info";
        logger[logLevel](
          "oracle-peer",
          JSON.stringify({
            msg: "Peer request completed",
            endpointPath,
            url,
            durationMs,
            data: response.data,
            status: response.status,
          }),
        );

        return validateAndExtractResponse(response.data);
      } catch (error: any) {
        const durationMs = Date.now() - start;
        logger.warn(
          "oracle-peer",
          JSON.stringify({
            msg: "Skipping peer signature",
            endpointPath,
            url,
            durationMs,
            timeoutMs: config.peerRequestTimeoutMs,
            error: String(error),
            errorResponse: error?.response?.data ?? error?.response?.body,
          }),
        );
        return [];
      }
    }),
  );

  return peerResponses.flat();
};

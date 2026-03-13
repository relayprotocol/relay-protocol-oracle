import { Type, type TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import {
  ExecutionMessage,
  SubmitWithdrawRequest,
} from "@relay-protocol/settlement-sdk";
import axios from "axios";
import crypto from "crypto";
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
import stringify from "json-stable-stringify";
import { Address, Hex, verifyMessage } from "viem";

import { getChain } from "../common/chains";
import { externalError, isExternalError } from "../common/error";
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
          requestBody: req.body,
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

// Fastify schema for the params needed to create a withdrawal address

export const WithdrawalAddressSchema = Type.Object({
  chainId: Type.String({
    description:
      "The hub chain id of the depository contract currently holding the funds",
  }),
  currency: Type.String({
    description: "The id of the currency as expressed on origin chain (string)",
  }),
  withdrawer: Type.String({
    description: "The address that is requiring the withdrawal",
  }),
  withdrawerChainId: Type.String({
    description: "The chain id of the address that is requiring the withdrawal",
  }),
  recipient: Type.String({
    description:
      "The address that will receive the withdrawn funds on destination chain",
  }),
  withdrawalNonce: Type.String({
    description:
      "Optional nonce to prevent collisions for similar withdrawals in the same block",
  }),
});

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

// shadow peers can receive traffic, but their signatures should not be
// included in oracle responses yet
const isShadowPeer = (url: string) =>
  url.includes("railway") || url.includes("relay-oracle.sovereign-labs.xyz");

/** Fan out the same attestation request to peer oracles and collect only
 * signatures whose execution payload matches the local execution. Failures and
 * timeouts are logged and skipped so one unhealthy peer does not fail the
 * entire request path.
 */
export const getPeerExecutionSignatures = async ({
  endpointPath,
  requestBody,
  requestApiKey,
  execution,
}: {
  endpointPath: string;
  requestBody: Record<string, unknown>;
  requestApiKey?: string | string[];
  execution?: ExecutionMessage;
}) => {
  if (!execution || !config.peers) {
    return [];
  }

  const peerResponses = await Promise.all(
    Object.entries(config.peers).map(async ([url, apiKey]) => {
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

        // Only consider the peer signature if the executions are equal
        if (
          areExecutionsEqual(response.data.execution, execution) &&
          !isShadowPeer(url)
        ) {
          return response.data.execution.signatures;
        }

        logger.warn(
          "oracle-peer",
          `Skipping mismatched peer execution (${endpointPath}): ${url}`,
        );
        return [];
      } catch (error: any) {
        logger.warn(
          "oracle-peer",
          JSON.stringify({
            msg: "Skipping peer signature",
            endpointPath,
            url,
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

// Utility for comparing two payload params (ignoring signatures)
export const arePayloadParamsEqual = (
  p1?: SubmitWithdrawRequest,
  p2?: SubmitWithdrawRequest,
) => {
  if (!p1 || !p2) {
    return false;
  }

  return (
    p1.chainId === p2.chainId &&
    p1.depository === p2.depository &&
    p1.currency === p2.currency &&
    p1.amount === p2.amount &&
    p1.spender === p2.spender &&
    p1.recipient === p2.recipient &&
    p1.nonce === p2.nonce &&
    p1.data === p2.data
  );
};

/** Fan out the same attestation request to peer oracles and collect only
 * signatures whose payload params match the local payload params. Failures and
 * timeouts are logged and skipped so one unhealthy peer does not fail the
 * entire request path.
 */
export const getPeerPayloadParamSignatures = async ({
  endpointPath,
  requestBody,
  requestApiKey,
  payloadParams,
}: {
  endpointPath: string;
  requestBody: Record<string, unknown>;
  requestApiKey?: string | string[];
  payloadParams: SubmitWithdrawRequest;
}) => {
  if (!config.peers) {
    return [];
  }

  const peerResponses = await Promise.all(
    Object.entries(config.peers).map(async ([url, apiKey]) => {
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

        // Only consider the peer signature if the payload params match
        if (
          arePayloadParamsEqual(response.data.payloadParams, payloadParams) &&
          !isShadowPeer(url)
        ) {
          return response.data.payloadParams.signatures;
        }

        logger.warn(
          "oracle-peer",
          `Skipping mismatched peer payload params (${endpointPath}): ${url}`,
        );
        return [];
      } catch (error: any) {
        logger.warn(
          "oracle-peer",
          JSON.stringify({
            msg: "Skipping peer signature",
            endpointPath,
            url,
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

export const verifyWithdrawalSignature = async (
  data: {
    chainId: string;
    currency: string;
    amount: string;
    ownerChainId: string;
    owner: string;
    recipient: string;
    nonce: string;
    additionalData?: any;
  },
  signature: string,
) => {
  // Verify the owner signature
  const hashToVerify = crypto
    .createHash("sha256")
    .update(
      stringify({
        chainId: data.chainId,
        currency: data.currency,
        amount: data.amount,
        ownerChainId: data.ownerChainId,
        owner: data.owner,
        recipient: data.recipient,
        nonce: data.nonce,
        additionalData: data.additionalData,
      })!,
    )
    .digest()
    .toString("hex");

  const ownerChain = await getChain(data.ownerChainId);
  if (ownerChain.vmType !== "ethereum-vm") {
    throw externalError("Signature verification not supported for owner chain");
  }

  // For now we only support "ethereum-vm" signatures
  const isSignatureValid = await verifyMessage({
    address: data.owner as Address,
    message: {
      raw: `0x${hashToVerify}`,
    },
    signature: signature as Hex,
  });
  if (!isSignatureValid) {
    throw externalError("Invalid signature");
  }
};

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

export const orderSchema = Type.Object(
  {
    version: Type.Literal("v1", {
      description: "The order schema version",
    }),
    solverChainId: Type.String({
      description: "The chain id of the solver address",
    }),
    solver: Type.String({
      description: "The solver address that signed the order",
    }),
    salt: Type.String({
      description: "Order salt used to make the order id unique",
    }),
    inputs: Type.Array(
      Type.Object({
        payment: Type.Object({
          chainId: Type.String({
            description: "The chain id where the input payment is deposited",
          }),
          currency: Type.String({
            description: "The input payment currency",
          }),
          amount: Type.String({
            description: "The expected input payment amount",
          }),
          weight: Type.String({
            description: "The input payment weight used for amount accounting",
          }),
        }),
        refunds: Type.Array(
          Type.Object({
            chainId: Type.String({
              description: "The chain id where this refund may be paid",
            }),
            recipient: Type.String({
              description: "The refund recipient",
            }),
            currency: Type.String({
              description: "The refund currency",
            }),
            minimumAmount: Type.String({
              description: "The minimum acceptable refund amount",
            }),
            deadline: Type.Number({
              description: "The refund payment deadline as a Unix timestamp",
            }),
            extraData: Type.String({
              description: "VM-specific extra data for the refund payment",
            }),
          }),
          { description: "Possible refunds for this input payment" },
        ),
      }),
      { description: "Input payments required by the order" },
    ),
    output: Type.Object({
      chainId: Type.String({
        description: "The chain id where the solver output is paid",
      }),
      payments: Type.Array(
        Type.Object({
          recipient: Type.String({
            description: "The output payment recipient",
          }),
          currency: Type.String({
            description: "The output payment currency",
          }),
          minimumAmount: Type.String({
            description: "The minimum acceptable output payment amount",
          }),
          expectedAmount: Type.String({
            description: "The expected output payment amount",
          }),
        }),
        { description: "Output payments the solver must make" },
      ),
      calls: Type.Array(Type.String({ description: "Encoded call data" }), {
        description: "Calls the solver must execute on the output chain",
      }),
      deadline: Type.Number({
        description: "The output payment deadline as a Unix timestamp",
      }),
      extraData: Type.String({
        description: "VM-specific extra data for the output payment",
      }),
    }),
    fees: Type.Array(
      Type.Object({
        recipientChainId: Type.String({
          description: "The chain id of the fee recipient",
        }),
        recipient: Type.String({
          description: "The fee recipient",
        }),
        currencyChainId: Type.String({
          description: "The chain id of the fee currency",
        }),
        currency: Type.String({
          description: "The fee currency",
        }),
        amount: Type.String({
          description: "The fee amount",
        }),
      }),
      { description: "Fees associated with the order" },
    ),
  },
  {
    description: "The order data",
  },
);

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
 *
 * When `ORACLE_SIGNERS` is set, returns as soon as `threshold` unique
 * multisig-eligible signers have responded. Falls back to waiting for all
 * peers when below target — never errors.
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
}): Promise<any[]> => {
  if (!config.peers) return [];

  const peerEntries = Object.entries(config.peers);
  const { oracleSigners: signers, oracleSignersThreshold: threshold } = config;

  if (signers && threshold === 0) return [];

  // Dedupe by signer (multisig rejects duplicates); resolve `enough` once
  // `matched` unique eligible signers arrive, so we stop waiting for dead peers.
  const collected: any[] = [];
  const seen = new Set<string>();
  let matched = 0;
  let resolveEnough!: () => void;
  const enough = new Promise<void>((r) => (resolveEnough = r));

  const record = (sigs: any[]) => {
    for (const s of sigs) {
      const signer =
        typeof s?.oracleSigner === "string" ? s.oracleSigner.toLowerCase() : undefined;
      if (signers && signer) {
        if (seen.has(signer)) continue;
        seen.add(signer);
        if (signers.has(signer)) matched++;
      }
      collected.push(s);
    }
    if (signers && matched >= threshold) resolveEnough();
  };

  const peerDone = peerEntries.map(([url, apiKey]) => {
    const start = Date.now();
    return axios
      .post(
        `${url}${endpointPath}`,
        { ...requestBody, requestPeerSignatures: false },
        {
          headers: { "x-api-key": apiKey === "pass-through" ? requestApiKey : apiKey },
          timeout: config.peerRequestTimeoutMs,
        },
      )
      .then((response) => {
        const durationMs = Date.now() - start;
        logger[durationMs > 5000 ? "warn" : "info"]("oracle-peer", JSON.stringify({
          msg: "Peer request completed", endpointPath, url, durationMs,
          data: response.data, status: response.status,
        }));
        try {
          record(validateAndExtractResponse(response.data));
        } catch (error: any) {
          logger.warn("oracle-peer", JSON.stringify({
            msg: "Skipping peer signature (validator error)",
            endpointPath, url, durationMs: Date.now() - start, error: String(error),
          }));
        }
      })
      .catch((error: any) => {
        logger.warn("oracle-peer", JSON.stringify({
          msg: "Skipping peer signature", endpointPath, url,
          durationMs: Date.now() - start, timeoutMs: config.peerRequestTimeoutMs,
          error: String(error), errorResponse: error?.response?.data ?? error?.response?.body,
        }));
      });
  });

  // Resolve as soon as `enough` fires (threshold met) or all peers settle.
  await Promise.race([enough, Promise.allSettled(peerDone)]);
  return [...collected];
};

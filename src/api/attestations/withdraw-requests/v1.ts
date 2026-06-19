import { Type } from "@fastify/type-provider-typebox";

import {
  Endpoint,
  ErrorResponses,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
  getPeerResponses,
  withdrawRequestAdditionalDataSchema,
} from "../../utils";
import { getChain } from "../../../common/chains";
import { signWithdrawRequestMessage } from "../../../common/signer";
import { config } from "../../../config";
import { AttestationService } from "../../../services/attestation";

const Schema = {
  body: Type.Object({
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
      description: "The chain id of the spender",
    }),
    spender: Type.String({
      description: "The spender address",
    }),
    receiver: Type.String({
      description: "The withdrawal recipient",
    }),
    nonce: Type.String({
      description: "Nonce for replay protection",
    }),
    additionalData: Type.Optional(withdrawRequestAdditionalDataSchema),
    hashIndexes: Type.Array(Type.Integer({ minimum: 0 }), {
      minItems: 1,
      description:
        "The hashesToSign indexes to load from the allocator for this withdrawal request",
    }),
    requestPeerSignatures: Type.Optional(
      Type.Boolean({
        description:
          "Whether to request signatures from any configured oracle peers",
      }),
    ),
  }),
  response: {
    ...ErrorResponses,
    200: Type.Object({
      withdrawRequest: Type.Object(
        {
          chainId: Type.Number({
            description: "The Hub EVM chain id",
          }),
          allocator: Type.String({
            description: "The allocator smart contract address on the Hub",
          }),
          withdrawRequestHash: Type.String({
            description: "The withdrawal request hash checked in the allocator",
          }),
          hashesToSign: Type.Array(Type.String(), {
            minItems: 1,
            description:
              "The non-zero hashesToSign values loaded from the allocator for the requested indexes",
          }),
          signatures: Type.Array(
            Type.Object({
              oracleSigner: Type.String({
                description: "The address of the oracle signer",
              }),
              signature: Type.String({
                description: "The message signature",
              }),
            }),
            { minItems: 1 },
          ),
        },
        {
          description: "The withdrawal request inclusion attestation",
        },
      ),
    }),
  },
};

type WithdrawRequestMessage = {
  chainId: number;
  allocator: string;
  withdrawRequestHash: string;
  hashesToSign: string[];
};

const areWithdrawRequestsEqual = (
  msg1?: WithdrawRequestMessage,
  msg2?: WithdrawRequestMessage,
) => {
  if (!msg1 || !msg2) {
    return false;
  }

  return (
    msg1.chainId === msg2.chainId &&
    msg1.allocator === msg2.allocator &&
    msg1.withdrawRequestHash === msg2.withdrawRequestHash &&
    msg1.hashesToSign.length === msg2.hashesToSign.length &&
    msg1.hashesToSign.every((hash, i) => hash === msg2.hashesToSign[i])
  );
};

export default {
  method: "POST",
  url: "/attestations/withdraw-requests/v1",
  schema: Schema,
  handler: async (
    req: FastifyRequestTypeBox<typeof Schema>,
    reply: FastifyReplyTypeBox<typeof Schema>,
  ) => {
    const chain = await getChain(req.body.chainId);
    const withdrawRequest =
      await new AttestationService().attestWithdrawRequest({
        chainId: req.body.chainId,
        depository: chain.depository!,
        currency: req.body.currency,
        amount: req.body.amount,
        spenderChainId: req.body.spenderChainId,
        spender: req.body.spender,
        receiver: req.body.receiver,
        nonce: req.body.nonce,
        additionalData: req.body.additionalData,
        hashIndexes: req.body.hashIndexes,
      });

    const peerSignatures =
      req.body.requestPeerSignatures && config.peers
        ? await getPeerResponses({
            endpointPath: req.originalUrl,
            requestBody: req.body,
            requestApiKey: req.headers["x-api-key"],
            validateAndExtractResponse: (peerData: any) => {
              if (
                areWithdrawRequestsEqual(
                  peerData.withdrawRequest,
                  withdrawRequest,
                )
              ) {
                return peerData.withdrawRequest.signatures;
              }

              return [];
            },
          })
        : [];

    return reply.send({
      withdrawRequest: {
        ...withdrawRequest,
        signatures: [
          await signWithdrawRequestMessage(withdrawRequest),
          ...peerSignatures,
        ],
      },
    });
  },
} as Endpoint;

import { Type } from "@fastify/type-provider-typebox";

import {
  Endpoint,
  ErrorResponses,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
  getPeerResponses,
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
          included: Type.Boolean({
            description:
              "Whether the withdrawal request has a non-empty allocator payload",
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
  included: boolean;
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
    msg1.included === msg2.included
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
    const withdrawRequest = await new AttestationService().attestWithdrawRequest(
      {
        chainId: req.body.chainId,
        depository: chain.depository!,
        currency: req.body.currency,
        amount: req.body.amount,
        spenderChainId: req.body.spenderChainId,
        spender: req.body.spender,
        receiver: req.body.receiver,
        nonce: req.body.nonce,
      },
    );

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

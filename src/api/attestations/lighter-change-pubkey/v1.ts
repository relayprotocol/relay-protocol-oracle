import { Type } from "@fastify/type-provider-typebox";
import { SubmitWithdrawRequest } from "@relay-protocol/settlement-sdk";

import {
  arePayloadParamsEqual,
  BigIntString,
  Endpoint,
  ErrorResponses,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
  getPeerResponses,
} from "../../utils";
import { signPayloadParams } from "../../../common/signer";
import { config } from "../../../config";

const Schema = {
  body: Type.Object({
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
      payloadParams: Type.Object(
        {
          chainId: Type.String(),
          depository: Type.String(),
          currency: Type.String(),
          amount: Type.String(),
          spender: Type.String(),
          recipient: Type.String(),
          nonce: Type.String(),
          data: Type.String(),
          signatures: Type.Array(
            Type.Object({
              allocatorSpenderChainId: BigIntString,
              allocatorSpenderContract: Type.String({
                description:
                  "The address of the spender contract on the allocator chain",
              }),
              oracleSigner: Type.String({
                description: "The address of the oracle signer",
              }),
              signature: Type.String({
                description: "The signature",
              }),
            }),
            {
              minItems: 1,
            },
          ),
        },
        { description: "Payload params to be used for the withdrawal" },
      ),
    }),
  },
};

export default {
  method: "POST",
  url: "/attestations/lighter-change-pubkey/v1",
  schema: Schema,
  handler: async (
    req: FastifyRequestTypeBox<typeof Schema>,
    reply: FastifyReplyTypeBox<typeof Schema>,
  ) => {
    const payloadParams: SubmitWithdrawRequest = {
      amount: "0",
      chainId:
        "24751429388881399765243452447207376042614090386756997212181931796575290791450",
      currency: "0",
      data: "0x000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008ee02f8e0000000000000000000000000000000000000000000000000000000000030d400000000000000000000000000000000000000000000000000000000000000028cf72c8cbd17afc724b33e2402173296f1c4a46bea48bfcc7a5da85c667a599d2ebef7c6e3714cbfc000000000000000000000000000000000000000000000000",
      depository: "723071",
      nonce:
        "0x404b91c35501d60996cabb9775c728c81dd1292055e457d82e17ae3b22e35a4e",
      recipient: "0",
      spender: "0x0000000000000000000000000000000000000000",
    };

    const peerSignatures =
      req.body.requestPeerSignatures && config.peers
        ? await getPeerResponses({
            endpointPath: req.originalUrl,
            requestBody: req.body,
            requestApiKey: req.headers["x-api-key"],
            validateAndExtractResponse: (peerData: any) => {
              if (
                arePayloadParamsEqual(peerData.payloadParams, payloadParams)
              ) {
                return peerData.payloadParams.signatures;
              }

              return [];
            },
          })
        : [];

    return reply.send({
      payloadParams: {
        ...payloadParams,
        signatures: [await signPayloadParams(payloadParams), ...peerSignatures],
      },
    });
  },
} as Endpoint;

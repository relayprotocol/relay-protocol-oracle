import { Type } from "@fastify/type-provider-typebox";
import { generateAddress } from "@relay-protocol/settlement-sdk";

import {
  arePayloadParamsEqual,
  BigIntString,
  Endpoint,
  ErrorResponses,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
  getPeerResponses,
  verifyWithdrawalSignature,
} from "../../utils";
import { getChain } from "../../../common/chains";
import { signPayloadParamsForChain } from "../../../common/signer";
import { config } from "../../../config";
import { AttestationService } from "../../../services/attestation";

const Schema = {
  body: Type.Object({
    settlementChainId: Type.String({
      description: "The chain to settle on",
    }),
    chainId: Type.String({
      description: "The chain id to withdraw on",
    }),
    currency: Type.String({
      description: "The currency to withdraw",
    }),
    amount: Type.String({
      description: "The amount to withdraw",
    }),
    ownerChainId: Type.String({
      description: "The chain id of the funds owner",
    }),
    owner: Type.String({
      description: "The owner of the funds",
    }),
    ownerSignature: Type.String({
      description: "Owner signature authorizing the withdrawal",
    }),
    recipient: Type.String({
      description: "The withdrawal recipient",
    }),
    nonce: Type.String({
      description: "Nonce for replay protection",
    }),
    additionalData: Type.Optional(
      Type.Object({
        "bitcoin-vm": Type.Optional(
          Type.Object({
            allocatorUtxos: Type.Array(
              Type.Object({
                txid: Type.String(),
                vout: Type.Number(),
                value: Type.String(),
              }),
            ),
            feeRate: Type.Number(),
          }),
        ),
        "hyperliquid-vm": Type.Optional(
          Type.Object({
            currencyHyperliquidSymbol: Type.String(),
            currentTime: Type.Number(),
          }),
        ),
      }),
    ),
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
  url: "/attestations/withdrawal-initiated/v2",
  schema: Schema,
  handler: async (
    req: FastifyRequestTypeBox<typeof Schema>,
    reply: FastifyReplyTypeBox<typeof Schema>,
  ) => {
    // Ensure the owner authorized the withdrawal
    await verifyWithdrawalSignature(req.body, req.body.ownerSignature);

    const chain = await getChain(req.body.chainId);

    const attestationService = new AttestationService();
    const { payloadParams } =
      await attestationService.attestWithdrawalInitiated(
        req.body.settlementChainId,
        {
          chainId: req.body.chainId,
          depository: chain.depository!,
          currency: req.body.currency,
          amount: req.body.amount,
          spender: generateAddress({
            family: await getChain(req.body.ownerChainId).then(
              (chain) => chain.vmType,
            ),
            chainId: req.body.ownerChainId,
            address: req.body.owner,
          }),
          recipient: req.body.recipient,
          nonce: req.body.nonce,
          additionalData: req.body.additionalData,
        },
      );

    const peerSignatures =
      req.body.requestPeerSignatures && config.peers
        ? await getPeerResponses({
            endpointPath: "/attestations/withdrawal-initiated/v2",
            requestBody: req.body,
            requestApiKey: req.headers["x-api-key"],
            validateAndExtractResponse: (peerResponse: any) => {
              if (
                arePayloadParamsEqual(
                  peerResponse.data.payloadParams,
                  payloadParams,
                )
              ) {
                return peerResponse.data.payloadParams.signatures;
              }

              return [];
            },
          })
        : [];

    return reply.send({
      payloadParams: {
        ...payloadParams,
        signatures: [
          await signPayloadParamsForChain(
            payloadParams,
            req.body.settlementChainId.toString(),
          ),
          ...peerSignatures,
        ],
      },
    });
  },
} as Endpoint;

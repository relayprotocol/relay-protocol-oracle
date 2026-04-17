import { Type } from "@fastify/type-provider-typebox";
import { generateAddress } from "@relay-protocol/settlement-sdk";
import {
  areExecutionsEqual,
  Endpoint,
  ErrorResponses,
  executionSchema,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
  getPeerResponses,
} from "../../utils";
import { getChain } from "../../../common/chains";
import { signExecutionMessage } from "../../../common/signer";
import { verifyWithdrawalSignature } from "../../../common/signature-verification";
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
        "lighter-vm": Type.Optional(
          Type.Object({
            nonce: Type.Integer({ minimum: 0 }),
            fromRouteType: Type.Integer({ minimum: 0 }),
            toRouteType: Type.Integer({ minimum: 0 }),
            apiKeyIndex: Type.Integer({ minimum: 0 }),
            usdcFee: Type.Integer({ minimum: 0 }),
            memo: Type.String(),
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
      withdrawalAddress: Type.String({
        description: "The address of the withdrawal",
      }),
      execution: executionSchema,
    }),
  },
};

export default {
  method: "POST",
  url: "/attestations/withdrawal-initiation/v2",
  schema: Schema,
  handler: async (
    req: FastifyRequestTypeBox<typeof Schema>,
    reply: FastifyReplyTypeBox<typeof Schema>,
  ) => {
    // Ensure the owner authorized the withdrawal
    await verifyWithdrawalSignature({
      data: req.body,
      signature: req.body.ownerSignature,
    });

    const chain = await getChain(req.body.chainId);

    const attestationService = new AttestationService();
    const { withdrawalAddress, execution } =
      await attestationService.attestWithdrawalInitiation({
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
      });

    const peerSignatures =
      req.body.requestPeerSignatures && config.peers
        ? await getPeerResponses({
            endpointPath: req.originalUrl,
            requestBody: req.body,
            requestApiKey: req.headers["x-api-key"],
            validateAndExtractResponse: (peerData: any) => {
              if (areExecutionsEqual(peerData.execution, execution)) {
                return peerData.execution.signatures;
              }

              return [];
            },
          })
        : [];

    return reply.send({
      withdrawalAddress,
      execution: {
        ...execution,
        signatures: [await signExecutionMessage(execution), ...peerSignatures],
      },
    });
  },
} as Endpoint;

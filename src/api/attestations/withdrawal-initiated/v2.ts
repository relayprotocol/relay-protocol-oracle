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
} from "../../utils";
import { getChain } from "../../../common/chains";
import { externalError } from "../../../common/error";
import { logger } from "../../../common/logger";
import {
  recoverModeSchemaFields,
  validateRecoverMode,
} from "../../../common/recover-mode-verification";
import { signPayloadParams } from "../../../common/signer";
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
    ...recoverModeSchemaFields,
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
            assetIndex: Type.Integer({ minimum: 0 }),
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
    const isRecoverMode = req.body.recoverMode === true;
    const attestationService = new AttestationService();

    if (isRecoverMode) {
      // Slow refund: skip user signature, validate the order against the
      // on-chain deposit + solver's no-fill-or-refund declaration instead.
      await validateRecoverMode({
        attestationService,
        ...req.body,
      });
      // Audit log — recoverMode bypasses user signature; every accepted
      // invocation must be observable.
      logger.info(
        "recover-mode-verification",
        JSON.stringify({
          msg: "recoverMode attestation accepted",
          endpoint: "withdrawal-initiated/v2",
          depositChainId: req.body.depositChainId,
          depositTransactionId: req.body.depositTransactionId,
          depositOnchainId: req.body.depositOnchainId,
          owner: req.body.owner,
          recipient: req.body.recipient,
          chainId: req.body.chainId,
        }),
      );
    } else {
      if (!req.body.ownerSignature) {
        throw externalError("ownerSignature is required");
      }
      await verifyWithdrawalSignature({
        data: req.body,
        signature: req.body.ownerSignature,
      });
    }

    const chain = await getChain(req.body.chainId);

    const { payloadParams } =
      await attestationService.attestWithdrawalInitiated({
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

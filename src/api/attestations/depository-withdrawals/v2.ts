import { Type } from "@fastify/type-provider-typebox";
import { generateAddress } from "@relay-protocol/settlement-sdk";

import {
  areExecutionsEqual,
  filterSignaturesByDomain,
  Endpoint,
  ErrorResponses,
  executionSchema,
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
import { signExecutionMessage } from "../../../common/signer";
import { verifyOwnerSignature } from "../../../common/signature-verification";
import { config } from "../../../config";
import { AttestationService } from "../../../services/attestation";

const MessageData = Type.Object({
  chainId: Type.String({
    description: "The chain id to withdraw on",
  }),
  depository: Type.Optional(
    Type.String({
      description:
        "The depository to withdraw from (defaults to the chain's primary depository)",
    }),
  ),
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
  transactionId: Type.Optional(
    Type.String({
      description:
        "The transaction id that executed the withdrawal (required for Hyperliquid VM)",
    }),
  ),
  hints: Type.Optional(
    Type.Object(
      {
        "ton-vm": Type.Optional(
          Type.Object({
            lt: Type.String({
              description:
                "The logical time of the executing tx on the depository wallet (required for ton-vm)",
            }),
          }),
        ),
      },
      { description: "Hints for verifying the executing tx" },
    ),
  ),
});

const Schema = {
  body: MessageData,
  response: {
    ...ErrorResponses,
    200: Type.Object({
      status: Type.Number({
        description:
          "The status of the withdrawal (0 = pending, 1 = executed, 2 = expired)",
      }),
      execution: executionSchema,
    }),
  },
};

export default {
  method: "POST",
  url: "/attestations/depository-withdrawals/v2",
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
          endpoint: "depository-withdrawals/v2",
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
      await verifyOwnerSignature({
        data: { ...req.body, operation: "withdrawal" },
        signature: req.body.ownerSignature,
      });
    }

    const chain = await getChain(req.body.chainId);
    const depository = req.body.depository ?? chain.depository!;

    const { status, execution } =
      await attestationService.attestDepositoryWithdrawalV2({
        chainId: req.body.chainId,
        depository,
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
        transactionId: req.body.transactionId,
        hints: req.body.hints,
        withdrawalAddressRequest: {
          chainId: req.body.chainId,
          depository,
          currency: req.body.currency,
          recipient: req.body.recipient,
          withdrawerChainId: req.body.ownerChainId,
          withdrawer: req.body.owner,
          withdrawalNonce: req.body.nonce,
        },
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

    const localExecutionSignature = execution
      ? await signExecutionMessage(execution)
      : undefined;

    return reply.send({
      status,
      execution:
        execution && localExecutionSignature
          ? {
              ...execution,
              signatures: [
                localExecutionSignature,
                ...filterSignaturesByDomain(
                  peerSignatures,
                  localExecutionSignature,
                  { chainId: "oracleChainId", contract: "oracleContract" },
                ),
              ],
            }
          : undefined,
    });
  },
} as Endpoint;

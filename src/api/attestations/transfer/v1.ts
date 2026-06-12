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
import { verifyOwnerSignature } from "../../../common/signature-verification";
import { config } from "../../../config";
import { AttestationService } from "../../../services/attestation";

const Schema = {
  body: Type.Object({
    chainId: Type.String({
      description: "The chain id of the currency being transferred",
    }),
    currency: Type.String({
      description: "The currency to transfer",
    }),
    amount: Type.String({
      description: "The amount to transfer",
    }),
    recipient: Type.String({
      description: "The hub address to transfer the funds to",
    }),
    nonce: Type.String({
      description: "Nonce for replay protection",
    }),
    ownerChainId: Type.String({
      description: "The chain id of the funds owner (whose alias holds them)",
    }),
    owner: Type.String({
      description: "The owner of the funds (origin-chain address)",
    }),
    ownerSignature: Type.String({
      description:
        "The owner's signature over the transfer request, proving alias ownership",
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
      execution: executionSchema,
    }),
  },
};

export default {
  method: "POST",
  url: "/attestations/transfer/v1",
  schema: Schema,
  handler: async (
    req: FastifyRequestTypeBox<typeof Schema>,
    reply: FastifyReplyTypeBox<typeof Schema>,
  ) => {
    const attestationService = new AttestationService();

    // Verify the owner controls the alias holding the funds.
    await verifyOwnerSignature({
      data: req.body,
      signature: req.body.ownerSignature,
    });

    // The alias the funds are credited to on the hub.
    const from = generateAddress({
      family: await getChain(req.body.ownerChainId).then(
        (chain) => chain.vmType,
      ),
      chainId: req.body.ownerChainId,
      address: req.body.owner,
    });

    const { execution } = await attestationService.attestTransfer({
      chainId: req.body.chainId,
      currency: req.body.currency,
      amount: req.body.amount,
      from,
      to: req.body.recipient,
      nonce: req.body.nonce,
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
      execution: {
        ...execution,
        signatures: [await signExecutionMessage(execution), ...peerSignatures],
      },
    });
  },
} as Endpoint;

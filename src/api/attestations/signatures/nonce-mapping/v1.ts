import { Type } from "@fastify/type-provider-typebox";

import {
  areGenericMappingsEqual,
  BigIntString,
  Endpoint,
  ErrorResponses,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
  getPeerResponses,
} from "../../../utils";
import { signGenericMappingMessage } from "../../../../common/signer";
import { config } from "../../../../config";
import { AttestationService } from "../../../../services/attestation";

const Schema = {
  body: Type.Object({
    walletChainId: Type.String({
      description: "The chain id of the wallet",
    }),
    wallet: Type.String({
      description: "The wallet address",
    }),
    nonce: Type.String({
      description: "The nonce to associate the id to",
    }),
    id: Type.String({
      description: "The id to associate the nonce to",
    }),
    signatureChainId: Type.String({
      description: "The chain id of the signature",
    }),
    signature: Type.String({
      description: "The signature for the mapping",
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
      genericMapping: Type.Object(
        {
          user: Type.String(),
          id: Type.String(),
          data: Type.String(),
          nonce: Type.String(),
          signatures: Type.Array(
            Type.Object({
              genericMappingChainId: BigIntString,
              genericMappingContract: Type.String({
                description:
                  "The address of the generic mapping contract on the Hub chain",
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
        { description: "Generic mapping message to be sent to the Hub" },
      ),
    }),
  },
};

export default {
  method: "POST",
  url: "/attestations/signatures/nonce-mapping/v1",
  schema: Schema,
  handler: async (
    req: FastifyRequestTypeBox<typeof Schema>,
    reply: FastifyReplyTypeBox<typeof Schema>,
  ) => {
    const { genericMapping } =
      await new AttestationService().attestNonceMappingSignature(req.body);

    const peerSignatures =
      req.body.requestPeerSignatures && config.peers
        ? await getPeerResponses({
            endpointPath: req.originalUrl,
            requestBody: req.body,
            requestApiKey: req.headers["x-api-key"],
            validateAndExtractResponse: (peerData: any) => {
              if (
                areGenericMappingsEqual(peerData.genericMapping, genericMapping)
              ) {
                return peerData.genericMapping.signatures;
              }

              return [];
            },
          })
        : [];

    return reply.send({
      genericMapping: {
        ...genericMapping,
        signatures: [
          ...(await signGenericMappingMessage(genericMapping)),
          ...peerSignatures,
        ],
      },
    });
  },
} as Endpoint;

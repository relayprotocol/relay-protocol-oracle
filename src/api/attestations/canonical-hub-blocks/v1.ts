import { Type } from "@fastify/type-provider-typebox";

import {
  BigIntString,
  Endpoint,
  ErrorResponses,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
  getPeerResponses,
} from "../../utils";
import { signCanonicalHubBlockMessage } from "../../../common/signer";
import { config } from "../../../config";
import { AttestationService } from "../../../services/attestation";

const Schema = {
  body: Type.Object({
    blockHash: Type.String({
      description: "The Hub block hash to attest as canonical",
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
      canonicalHubBlock: Type.Object(
        {
          chainId: Type.Number(),
          blockNumber: BigIntString,
          blockHash: Type.String(),
          stateRoot: Type.String(),
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
          description: "The canonical Hub block attestation",
        },
      ),
    }),
  },
};

type CanonicalHubBlockMessage = {
  chainId: number;
  blockNumber: bigint;
  blockHash: string;
  stateRoot: string;
};

const areCanonicalHubBlocksEqual = (
  msg1?: CanonicalHubBlockMessage,
  msg2?: CanonicalHubBlockMessage,
) => {
  if (!msg1 || !msg2) {
    return false;
  }

  return (
    msg1.chainId === msg2.chainId &&
    BigInt(msg1.blockNumber) === BigInt(msg2.blockNumber) &&
    msg1.blockHash === msg2.blockHash &&
    msg1.stateRoot === msg2.stateRoot
  );
};

export default {
  method: "POST",
  url: "/attestations/canonical-hub-blocks/v1",
  schema: Schema,
  handler: async (
    req: FastifyRequestTypeBox<typeof Schema>,
    reply: FastifyReplyTypeBox<typeof Schema>,
  ) => {
    const canonicalHubBlock =
      await new AttestationService().attestCanonicalHubBlock(req.body);

    const peerSignatures =
      req.body.requestPeerSignatures && config.peers
        ? await getPeerResponses({
            endpointPath: req.originalUrl,
            requestBody: req.body,
            requestApiKey: req.headers["x-api-key"],
            validateAndExtractResponse: (peerData: any) => {
              if (
                areCanonicalHubBlocksEqual(
                  peerData.canonicalHubBlock,
                  canonicalHubBlock,
                )
              ) {
                return peerData.canonicalHubBlock.signatures;
              }

              return [];
            },
          })
        : [];

    return reply.send({
      canonicalHubBlock: {
        ...canonicalHubBlock,
        signatures: [
          await signCanonicalHubBlockMessage(canonicalHubBlock),
          ...peerSignatures,
        ],
      },
    });
  },
} as Endpoint;

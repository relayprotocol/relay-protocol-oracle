import { Type } from "@fastify/type-provider-typebox";

import { Endpoint, FastifyReplyTypeBox, FastifyRequestTypeBox } from "../utils";
import { getChains } from "../../common/chains";

const Schema = {
  response: {
    200: Type.Object({
      chains: Type.Array(
        Type.Object({
          id: Type.String({ description: "The id of the chain" }),
          vmType: Type.Union(
            [
              Type.Literal("bitcoin-vm"),
              Type.Literal("ethereum-vm"),
              Type.Literal("hyperliquid-vm"),
              Type.Literal("solana-vm"),
              Type.Literal("sui-vm"),
              Type.Literal("ton-vm"),
              Type.Literal("tron-vm"),
            ],
            {
              description: "The vm type of the chain",
            }
          ),
          escrow: Type.String({
            description: "The escrow address for the chain",
          }),
        }),
        { description: "A list of supported chains" }
      ),
    }),
  },
};

export default {
  method: "GET",
  url: "/chains/v1",
  schema: Schema,
  handler: async (
    _req: FastifyRequestTypeBox<typeof Schema>,
    reply: FastifyReplyTypeBox<typeof Schema>
  ) => {
    const chains = await getChains();

    return reply.send({
      chains: Object.values(chains).map((chain) => ({
        id: chain.id,
        vmType: chain.vmType,
        escrow: chain.escrow,
      })),
    });
  },
} as Endpoint;

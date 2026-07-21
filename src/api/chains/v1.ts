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
              Type.Literal("gateway-vm"),
              Type.Literal("hyperliquid-vm"),
              Type.Literal("lighter-vm"),
              Type.Literal("solana-vm"),
              Type.Literal("ton-vm"),
              Type.Literal("tron-vm"),
              Type.Literal("xrp-vm"),
            ],
            {
              description: "The vm type of the chain",
            },
          ),
          depository: Type.Optional(
            Type.String({
              description: "The depository address for the chain",
            }),
          ),
        }),
        { description: "A list of supported chains" },
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
    reply: FastifyReplyTypeBox<typeof Schema>,
  ) => {
    const chains = await getChains();

    return reply.send({
      chains: Object.values(chains).map((chain) => ({
        id: chain.id,
        vmType: chain.vmType as Exclude<typeof chain.vmType, "sui-vm">,
        depository: chain.depository,
      })),
    });
  },
} as Endpoint;

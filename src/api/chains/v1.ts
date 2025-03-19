import { Type } from "@fastify/type-provider-typebox";

import { Endpoint, FastifyReplyTypeBox, FastifyRequestTypeBox } from "../utils";
import { getChains } from "../../common/chains";

const Schema = {
  response: {
    200: Type.Object({
      chains: Type.Array(
        Type.Object({
          id: Type.Number({ description: "The id of the chain" }),
          name: Type.String({ description: "The name of the chain" }),
          vmType: Type.Union([Type.Literal("ethereum-vm")], {
            description: "The VM type of the chain",
          }),
          escrow: Type.Optional(
            Type.String({
              description: "The escrow address for the chain",
            })
          ),
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
        name: chain.name,
        vmType: chain.vmType,
        escrow: chain.metadata?.escrow,
      })),
    });
  },
} as Endpoint;

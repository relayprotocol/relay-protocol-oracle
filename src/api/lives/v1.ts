import { Type } from "@fastify/type-provider-typebox";

import { Endpoint, FastifyReplyTypeBox, FastifyRequestTypeBox } from "../utils";

const Schema = {
  querystring: Type.Object({
    withReport: Type.Optional(
      Type.String({ description: "Set to 1 or true to include the deployed image tag." }),
    ),
  }),
  response: {
    200: Type.Object({
      status: Type.String({ description: "The status of the service" }),
      version: Type.Optional(Type.String({ description: "The deployed image tag" })),
    }),
  },
};

export default {
  method: "GET",
  url: "/lives/v1",
  schema: Schema,
  handler: async (
    req: FastifyRequestTypeBox<typeof Schema>,
    reply: FastifyReplyTypeBox<typeof Schema>,
  ) => {
    const withReport = req.query.withReport === "1" || req.query.withReport === "true";
    return reply.send({
      status: "ok",
      ...(withReport && { version: String(process.env.IMAGE_TAG) }),
    });
  },
} as Endpoint;

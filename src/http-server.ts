import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import Fastify from "fastify";

import { setupEndpoints } from "./api";
import { logger } from "./common/logger";
import { config } from "./config";
import { getSigningWallet, SigningModule } from "./signers";

const COMPONENT = "http-server";

const httpServer = Fastify().withTypeProvider<TypeBoxTypeProvider>();

// Setup swagger
const setupSwagger = async () => {
  await httpServer.register(fastifySwagger, {
    mode: "dynamic",
    openapi: {
      info: {
        title: "Relay Protocol Oracle API",
        version: "v1",
      },
    },
  });
  await httpServer.register(fastifySwaggerUi, {
    routePrefix: "/documentation",
    uiConfig: {
      docExpansion: "full",
      deepLinking: false,
    },
    uiHooks: {
      onRequest: function (_request, _reply, next) {
        next();
      },
      preHandler: function (_request, _reply, next) {
        next();
      },
    },
    staticCSP: true,
    transformStaticCSP: (header) => header,
    transformSpecification: (swaggerObject, _request, _reply) => {
      return swaggerObject;
    },
    transformSpecificationClone: true,
  });
};

setupSwagger().then(() => {
  // Setup authentication
  httpServer.addHook("preHandler", (req, reply, done) => {
    // Skip these routes
    if (
      req.url === "/" ||
      req.url.startsWith("/documentation") ||
      req.url.startsWith("/lives")
    ) {
      return done();
    }

    if (config.apiKeys) {
      const apiKey = req.headers["x-api-key"] as string | undefined;
      if (!apiKey || !config.apiKeys[apiKey]) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
    }

    return done();
  });

  // Setup endpoints
  setupEndpoints(httpServer);

  // Start listening
  httpServer.listen(
    {
      host: "0.0.0.0",
      port: config.httpPort,
    },
    async (error) => {
      if (error) {
        logger.error(
          COMPONENT,
          JSON.stringify({
            msg: `Failed to start http server: ${error}`,
            stack: error?.stack,
          }),
        );
        process.exit(1);
      }

      const signer = await getSigningWallet(
        (config.signingModule as SigningModule) ?? "raw-private-key",
      );

      logger.info(
        COMPONENT,
        JSON.stringify({
          msg: "Http server started",
          signer: signer.address.toLowerCase(),
        }),
      );
    },
  );
});

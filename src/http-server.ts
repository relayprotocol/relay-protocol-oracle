import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import Fastify, { FastifyInstance } from "fastify";

import { setupEndpoints } from "./api";
import { logger } from "./common/logger";
import { createFixedWindowRateLimiter } from "./common/rate-limit";
import { config } from "./config";
import { getSigningWallet } from "./signers";

const COMPONENT = "http-server";

// Setup swagger
const setupSwagger = async (httpServer: FastifyInstance) => {
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

export const buildHttpServer = async () => {
  const httpServer = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  const unauthenticatedRateLimiter = createFixedWindowRateLimiter({
    max: config.unauthenticatedRateLimitMax,
    windowMs: config.unauthenticatedRateLimitWindowMs,
  });

  await setupSwagger(httpServer);

  // Setup unauthenticated rate limiting
  httpServer.addHook("preHandler", (req, reply, done) => {
    // Skip these routes
    if (
      req.url === "/" ||
      req.url.startsWith("/documentation") ||
      req.url.startsWith("/lives")
    ) {
      return done();
    }

    const apiKey = req.headers["x-api-key"] as string | undefined;
    const hasValidApiKey = Boolean(apiKey && config.apiKeys?.[apiKey]);

    if (!hasValidApiKey) {
      const rateLimit = unauthenticatedRateLimiter.check(req.ip);
      const retryAfterSeconds = Math.ceil(rateLimit.resetMs / 1000);

      reply
        .header("x-ratelimit-limit", rateLimit.limit)
        .header("x-ratelimit-remaining", rateLimit.remaining)
        .header("x-ratelimit-reset", retryAfterSeconds);

      if (!rateLimit.allowed) {
        return reply
          .code(429)
          .header("retry-after", retryAfterSeconds)
          .send({ error: "Rate limit exceeded" });
      }
    }

    return done();
  });

  // Setup endpoints
  setupEndpoints(httpServer);

  return httpServer;
};

export const startHttpServer = async () => {
  const httpServer = await buildHttpServer();

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

      const signer = await getSigningWallet();

      logger.info(
        COMPONENT,
        JSON.stringify({
          msg: "Http server started",
          signer: signer.address.toLowerCase(),
        }),
      );
    },
  );
};

import { FastifyInstance } from "fastify";

import { Endpoint, errorWrapper } from "./utils";

// Import all endpoints
import chainsV1 from "./chains/v1";
import attestationsEscrowDepositsV1 from "./attestations/escrow-deposits/v1";
import attestationsSolverFillV1 from "./attestations/solver-fill/v1";
import attestationsSolverRefundV1 from "./attestations/solver-refund/v1";

// Initialize all endpoints
const endpoints = [
  chainsV1,
  attestationsEscrowDepositsV1,
  attestationsSolverFillV1,
  attestationsSolverRefundV1,
] as Endpoint[];
export const setupEndpoints = (app: FastifyInstance) => {
  endpoints.forEach((endpoint) =>
    app.route({
      ...endpoint,
      handler: errorWrapper(endpoint.url, endpoint.handler),
    })
  );
};

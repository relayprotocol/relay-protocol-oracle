import { FastifyInstance } from "fastify";

import { Endpoint, errorWrapper } from "./utils";

// Import all endpoints
import chainsV1 from "./chains/v1";

import attestationsDepositoryDepositsV1 from "./attestations/depository-deposits/v1";
import attestationsDepositoryWithdrawalsV1 from "./attestations/depository-withdrawals/v1";
import attestationsSolverFillV1 from "./attestations/solver-fills/v1";
import attestationsSolverRefundV1 from "./attestations/solver-refunds/v1";

// Initialize all endpoints
const endpoints = [
  chainsV1,
  attestationsDepositoryDepositsV1,
  attestationsDepositoryWithdrawalsV1,
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

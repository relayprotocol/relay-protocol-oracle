import { FastifyInstance } from "fastify";

import { Endpoint, errorWrapper } from "./utils";

// Import all endpoints
import attestationsDepositoryDepositsV1 from "./attestations/depository-deposits/v1";
import attestationsDepositoryWithdrawalsV1 from "./attestations/depository-withdrawals/v1";
import attestationsDepositoryWithdrawalsV2 from "./attestations/depository-withdrawals/v2";
import attestationsSignaturesNoFillOrRefundV1 from "./attestations/signatures/no-fill-or-refund/v1";
import attestationsSignaturesNonceMappingV1 from "./attestations/signatures/nonce-mapping/v1";
import attestationsSolverFillV1 from "./attestations/solver-fills/v1";
import attestationsRecoverV1 from "./attestations/recover/v1";
import attestationsSolverRefundV1 from "./attestations/solver-refunds/v1";
import attestationsWithdrawalsInitiationV2 from "./attestations/withdrawal-initiation/v2";
import attestationsWithdrawalsInitiatedV2 from "./attestations/withdrawal-initiated/v2";
import chainsV1 from "./chains/v1";
import livesV1 from "./lives/v1";

// Initialize all endpoints
const endpoints = [
  attestationsDepositoryDepositsV1,
  attestationsDepositoryWithdrawalsV1,
  attestationsDepositoryWithdrawalsV2,
  attestationsSignaturesNoFillOrRefundV1,
  attestationsSignaturesNonceMappingV1,
  attestationsWithdrawalsInitiationV2,
  attestationsWithdrawalsInitiatedV2,
  attestationsSolverFillV1,
  attestationsSolverRefundV1,
  attestationsRecoverV1,
  chainsV1,
  livesV1,
] as Endpoint[];
export const setupEndpoints = (app: FastifyInstance) => {
  endpoints.forEach((endpoint) =>
    app.route({
      ...endpoint,
      handler: errorWrapper(endpoint.url, endpoint.handler),
    }),
  );
};

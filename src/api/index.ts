import { FastifyInstance } from "fastify";

import { Endpoint, errorWrapper } from "./utils";

// Import all endpoints
import attestationsDepositAddressTriggersV1 from "./attestations/deposit-address-triggers/v1";
import attestationsWithdrawRequestsV1 from "./attestations/withdraw-requests/v1";
import attestationsWithdrawRequestAuthorizationV1 from "./attestations/withdraw-request-authorization/v1";
import attestationsDepositoryDepositsV1 from "./attestations/depository-deposits/v1";
import attestationsDepositoryWithdrawalsV2 from "./attestations/depository-withdrawals/v2";
import attestationsDepositoryWithdrawalsV3 from "./attestations/depository-withdrawals/v3";
import attestationsSignaturesNoFillOrRefundV1 from "./attestations/signatures/no-fill-or-refund/v1";
import attestationsSignaturesNonceMappingV2 from "./attestations/signatures/nonce-mapping/v2";
import attestationsSolverFillV1 from "./attestations/solver-fills/v1";
import attestationsWithdrawAndFillV1 from "./attestations/withdraw-and-fill/v1";
import attestationsWithdrawAndRefundV1 from "./attestations/withdraw-and-refund/v1";
import attestationsRecoverV1 from "./attestations/recover/v1";
import attestationsSolverRefundV1 from "./attestations/solver-refunds/v1";
import attestationsTransferV1 from "./attestations/transfer/v1";
import attestationsWithdrawalsInitiationV2 from "./attestations/withdrawal-initiation/v2";
import attestationsWithdrawalsInitiatedV2 from "./attestations/withdrawal-initiated/v2";
import chainsV1 from "./chains/v1";
import livesV1 from "./lives/v1";

// Initialize all endpoints
const endpoints = [
  attestationsDepositAddressTriggersV1,
  attestationsWithdrawRequestsV1,
  attestationsWithdrawRequestAuthorizationV1,
  attestationsDepositoryDepositsV1,
  attestationsDepositoryWithdrawalsV2,
  attestationsDepositoryWithdrawalsV3,
  attestationsSignaturesNoFillOrRefundV1,
  attestationsSignaturesNonceMappingV2,
  attestationsWithdrawalsInitiationV2,
  attestationsWithdrawalsInitiatedV2,
  attestationsSolverFillV1,
  attestationsWithdrawAndFillV1,
  attestationsWithdrawAndRefundV1,
  attestationsSolverRefundV1,
  attestationsRecoverV1,
  attestationsTransferV1,
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

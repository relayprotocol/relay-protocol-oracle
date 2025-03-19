import { FastifyInstance } from "fastify";

import { Endpoint, errorWrapper } from "./utils";

// Import all endpoints
import chainsV1 from "./chains/v1";
import transactionEntriesV1 from "./transaction-entries/v1";

// Initialize all endpoints
const endpoints = [chainsV1, transactionEntriesV1] as Endpoint[];
export const setupEndpoints = (app: FastifyInstance) => {
  endpoints.forEach((endpoint) =>
    app.route({
      ...endpoint,
      handler: errorWrapper(endpoint.url, endpoint.handler),
    })
  );
};

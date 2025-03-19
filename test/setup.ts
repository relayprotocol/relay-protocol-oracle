// Initialize environment variables
import "./env";

import { db } from "../src/common/db";

import { chains } from "./common/chains";

// Setup
export default async () => {
  for (const chain of chains) {
    await db.oneOrNone(
      `
        INSERT INTO chains (
          id,
          name,
          vm_type,
          http_rpc_url,
          metadata
        ) VALUES (
          $/id/,
          $/name/,
          $/vmType/,
          $/httpRpcUrl/,
          $/metadata:json/
        ) ON CONFLICT DO NOTHING
      `,
      {
        id: chain.id,
        name: chain.name,
        vmType: chain.vmType,
        httpRpcUrl: chain.httpRpcUrl,
        metadata: chain.metadata ?? null,
      }
    );
  }
};

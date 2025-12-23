import { randomUUID } from "crypto";

import { getChain } from "./chains";
import { logger } from "./logger";

export const getTrackingId = () => randomUUID();

export const logRpcUsage = async (
  chainId: string,
  method: string,
  trackingId: string
) => {
  const chain = await getChain(chainId);
  logger.info(
    "rpc-usage",
    JSON.stringify({
      chainId,
      vmType: chain.vmType,
      method,
      trackingId,
    })
  );
};

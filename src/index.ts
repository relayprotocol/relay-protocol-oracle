// Initialize http server
import "./http-server";

import v8 from "v8";

import { logger } from "./common/logger";

const COMPONENT = "process";

// Log unhandled errors
process.on("unhandledRejection", (error: any) => {
  logger.error(
    COMPONENT,
    JSON.stringify({
      msg: "Unhandled rejection",
      error,
      stack: error?.stack,
    }),
  );
});
process.on("uncaughtException", (error: any) => {
  logger.error(
    COMPONENT,
    JSON.stringify({
      msg: "Uncaught exception",
      error,
      stack: error?.stack,
    }),
  );
});

// Periodic memory usage reporting (every 60s)
setInterval(() => {
  const mem = process.memoryUsage();
  const heap = v8.getHeapStatistics();

  // Count active resources by type (e.g. TCPSocketWrap, Timeout, TLSWrap)
  const resources: Record<string, number> = {};
  for (const r of process.getActiveResourcesInfo()) {
    resources[r] = (resources[r] ?? 0) + 1;
  }

  logger.info(
    "memory",
    JSON.stringify({
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
      externalMB: Math.round(mem.external / 1024 / 1024),
      nativeContexts: heap.number_of_native_contexts,
      detachedContexts: heap.number_of_detached_contexts,
      mallocedMB: Math.round(heap.malloced_memory / 1024 / 1024),
      peakMallocedMB: Math.round(heap.peak_malloced_memory / 1024 / 1024),
      tcpSockets: resources["TCPSocketWrap"] ?? 0,
      tlsWraps: resources["TLSWrap"] ?? 0,
      timeouts: resources["Timeout"] ?? 0,
      totalActiveResources: process.getActiveResourcesInfo().length,
    }),
  );
}, 60_000).unref();

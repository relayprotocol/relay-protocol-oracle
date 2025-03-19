import cron from "node-cron";

import { ABI, extractRelevantLogs } from "./utils";
import { getChains } from "../../../../common/chains";
import { logger } from "../../../../common/logger";
import { redis } from "../../../../common/redis";
import { httpRpc, wsRpc } from "../../../../common/vm/evm/rpc";
import { mqProcessEventsEvm, mqProcessTransactionEvm } from "../../../../jobs";

const COMPONENT = "cron-listen-evm";

// Continuously listen for new events via websocket (if available)
(async () => {
  const chains = await getChains();
  await Promise.all(
    Object.values(chains).map(async (chain) => {
      const rpc = await wsRpc(chain.id);
      if (rpc) {
        rpc.watchEvent({
          events: ABI,
          onLogs: async (logs) => {
            const relevantLogs = await extractRelevantLogs(chain.id, logs);
            await Promise.all(
              relevantLogs.map(async (log) => {
                if (log.transactionHash) {
                  await mqProcessTransactionEvm.send({
                    chainId: chain.id,
                    transactionHash: log.transactionHash.toLowerCase(),
                  });
                }
              })
            );
          },
        });
      }
    })
  );
})();

const MAX_BLOCKS_TO_POLL = 10000;

// Every few seconds, poll new blocks for events
cron.schedule("*/5 * * * * *", async () => {
  const chains = await getChains();
  await Promise.all(
    Object.values(chains).map(async (chain) => {
      try {
        const rpc = await httpRpc(chain.id);

        // Always listen from the last cached block to the current block
        let lastBlock = Number(
          (await redis.get(`${COMPONENT}:last-block:${chain.id}`)) ?? 0
        );
        const currentBlock = await rpc
          .getBlock({ blockTag: "latest" })
          .then((b) => Number(b.number));

        // Avoid processing too many blocks
        if (lastBlock && currentBlock - MAX_BLOCKS_TO_POLL > lastBlock) {
          logger.error(
            COMPONENT,
            JSON.stringify({
              msg: "Attempt to process too many blocks",
              chainId: chain.id,
              lastBlock,
              currentBlock,
            })
          );

          lastBlock = currentBlock - MAX_BLOCKS_TO_POLL;
        }

        // Send to the event processing queue
        await mqProcessEventsEvm.send({
          chainId: chain.id,
          fromBlock: lastBlock ? lastBlock + 1 : currentBlock - 10,
          toBlock: currentBlock,
        });

        // Have some redundancy to avoid issues where the transactions of the latest block are not available
        await redis.set(
          `${COMPONENT}:last-block:${chain.id}`,
          currentBlock - 3,
          "EX",
          24 * 3600
        );
      } catch (error) {
        logger.error(
          COMPONENT,
          JSON.stringify({
            msg: "Error polling for new blocks",
            chainId: chain.id,
            error,
            stack: (error as any).stack,
          })
        );
      }
    })
  );
});

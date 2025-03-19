import { ABI, extractRelevantLogs } from "./utils";
import { setupQueue } from "../../../../common/mq";
import { httpRpc } from "../../../../common/vm/evm/rpc";
import { mqProcessTransactionEvm } from "../../../../jobs";

const COMPONENT = "mq-process-events-evm";

type Data = {
  chainId: number;
  fromBlock: number;
  toBlock: number;
};

const handler = async (data: Data) => {
  const { chainId, fromBlock, toBlock } = data;

  const rpc = await httpRpc(chainId);
  const logs = await rpc.getLogs({
    fromBlock: BigInt(fromBlock),
    toBlock: BigInt(toBlock),
    events: ABI,
  });

  const relevantLogs = await extractRelevantLogs(chainId, logs);
  await Promise.all(
    relevantLogs.map(async (log) => {
      if (log.transactionHash) {
        await mqProcessTransactionEvm.send({
          chainId: chainId,
          transactionHash: log.transactionHash.toLowerCase(),
        });
      }
    })
  );
};

const { send } = setupQueue(COMPONENT, handler);

export { send };

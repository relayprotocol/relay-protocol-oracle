import { ABI, extractAndProcessLogs } from "./utils";
import { setupQueue } from "../../../../common/mq";
import { httpRpc } from "../../../../common/vm/evm/rpc";

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

  await extractAndProcessLogs(chainId, logs);
};

const { send } = setupQueue(COMPONENT, handler);

export { send };

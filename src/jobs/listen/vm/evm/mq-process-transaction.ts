import { Hex } from "viem";

import { extractTransactionEntries } from "./utils";
import { getChain } from "../../../../common/chains";
import { setupQueue } from "../../../../common/mq";
import { httpRpc } from "../../../../common/vm/evm/rpc";
import { saveTransactionEntry } from "../../../../models/transactions";

const COMPONENT = "mq-evm-process-transaction";

type Data = {
  chainId: number;
  transactionHash: string;
};

const handler = async (data: Data) => {
  const { chainId, transactionHash } = data;

  const rpc = await httpRpc(chainId);

  const transactionReceipt = await rpc.getTransactionReceipt({
    hash: transactionHash as Hex,
  });

  // Extract any transaction entries
  const transactionEntries = await extractTransactionEntries(
    chainId,
    transactionReceipt,
    () =>
      rpc.getTransaction({
        hash: transactionHash as Hex,
      })
  );
  if (!transactionEntries.length) {
    return;
  }

  const isFinalized = await getChain(chainId).then(async (chain) => {
    const latestBlock = await rpc.getBlockNumber();
    return (
      latestBlock - transactionReceipt.blockNumber >
      chain.metadata.blockConfirmations
    );
  });
  if (isFinalized) {
    // We only save transaction entries which are finalized
    await Promise.all(transactionEntries.map(saveTransactionEntry));
  } else {
    // TODO: Non-finalized transaction entries are provided via websockets
  }
};

const { send } = setupQueue(COMPONENT, handler);

export { send };

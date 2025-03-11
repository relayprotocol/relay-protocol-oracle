import { Hex } from "viem";

import { extractTransactionEntries } from "./utils";
import { setupQueue } from "../../../../common/mq";
import { httpRpc } from "../../../../common/vm/evm/rpc";
import { saveTransactionEntry } from "../../../../models/transactions";

const COMPONENT = "mq-evm-process-transaction";

type Data = {
  chainId: number;
  transactionHash: string;
  waitForFinalization?: boolean;
};

const handler = async (data: Data) => {
  const { chainId, transactionHash, waitForFinalization } = data;

  const rpc = await httpRpc(chainId);

  const transactionEntries = await extractTransactionEntries(
    chainId,
    await rpc.getTransactionReceipt({
      hash: transactionHash as Hex,
    }),
    () =>
      rpc.getTransaction({
        hash: transactionHash as Hex,
      })
  );

  if (waitForFinalization) {
    // TODO: Implement logic to wait for transaction finalization

    await Promise.all(transactionEntries.map(saveTransactionEntry));
  } else {
  }
};

const { send } = setupQueue(COMPONENT, handler);

export { send };

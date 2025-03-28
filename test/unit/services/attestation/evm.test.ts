import { describe, expect, it, jest } from "@jest/globals";
import {
  Hex,
  Log,
  TransactionReceipt,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  zeroAddress,
  zeroHash,
} from "viem";

import { randomHex, randomNumber } from "../../../common/utils";

import { getChains } from "../../../../src/common/chains";
import { httpRpc } from "../../../../src/common/vm/evm/rpc";
import {
  ABI,
  EvmAttestationService,
} from "../../../../src/services/attestation/evm";
import { EscrowDepositMessage } from "../../../../src/services/attestation/types";

jest.mock("../../src/common/chains", () => {
  const chains: Record<number, any> = {
    1000: {
      id: 1000,
      name: "Test",
      vmType: "ethereum-vm",
      httpRpcUrl: "http://127.0.0.1:8545",
      escrow: "0x0000000000000000000000000000000000001000",
    },
  };
  return {
    getChains: () => chains,
    getChain: (chainId: number) => chains[chainId],
  };
});
jest.mock("../../src/common/vm/evm/rpc", () => {
  return {
    httpRpc: jest.fn(),
  };
});

const generateTransactionReceipt = (
  transactionHash: string,
  logs: Log<bigint, number, false>[]
): TransactionReceipt => {
  return {
    blockHash: randomHex(32) as Hex,
    blockNumber: BigInt(randomNumber(1e10)),
    cumulativeGasUsed: 0n,
    effectiveGasPrice: 0n,
    contractAddress: randomHex(20) as Hex,
    from: randomHex(20) as Hex,
    to: randomHex(20) as Hex,
    gasUsed: 0n,
    logs,
    logsBloom: randomHex(32) as Hex,
    status: "success",
    transactionHash: transactionHash as Hex,
    transactionIndex: 0,
    type: "eip1559",
  };
};

const generateTransactionLog = ({
  transactionHash,
  logIndex,
  address,
  data,
  topics,
}: {
  transactionHash: string;
  logIndex: number;
  address: string;
  data: string;
  topics: string[];
}): Log<bigint, number, false> => {
  return {
    address: address as Hex,
    blockHash: randomHex(32) as Hex,
    blockNumber: BigInt(randomNumber(1e10)),
    data: data as Hex,
    logIndex,
    transactionHash: transactionHash as Hex,
    transactionIndex: 0,
    removed: false,
    topics: topics as [Hex, ...Hex[]],
  };
};

const generateTransferLog = ({
  transactionHash,
  logIndex,
  from,
  to,
  token,
  amount,
}: {
  transactionHash: string;
  logIndex: number;
  from: string;
  to: string;
  token: string;
  amount: string;
}) => {
  const topics = encodeEventTopics({
    abi: ABI,
    eventName: "Transfer",
    args: { from: from as Hex, to: to as Hex },
  });
  const data = encodeAbiParameters(
    [{ name: "amount", type: "uint256" }],
    [BigInt(amount)]
  );

  return generateTransactionLog({
    transactionHash,
    logIndex,
    address: token,
    data,
    topics: topics as string[],
  });
};

const generateNativeDepositLog = ({
  transactionHash,
  logIndex,
  from,
  to,
  amount,
  id,
}: {
  transactionHash: string;
  logIndex: number;
  from: string;
  to: string;
  amount: string;
  id: string;
}) => {
  const topics = encodeEventTopics({
    abi: ABI,
    eventName: "NativeDeposit",
  });
  const data = encodeAbiParameters(
    [
      { name: "from", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "id", type: "bytes32" },
    ],
    [from as Hex, BigInt(amount), id as Hex]
  );

  return generateTransactionLog({
    transactionHash,
    logIndex,
    address: to,
    data,
    topics: topics as string[],
  });
};

const generateErc20DepositLog = ({
  transactionHash,
  logIndex,
  from,
  to,
  token,
  amount,
  id,
}: {
  transactionHash: string;
  logIndex: number;
  from: string;
  to: string;
  token: string;
  amount: string;
  id: string;
}) => {
  const topics = encodeEventTopics({
    abi: ABI,
    eventName: "Erc20Deposit",
  });
  const data = encodeAbiParameters(
    [
      { name: "from", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "id", type: "bytes32" },
    ],
    [from as Hex, token as Hex, BigInt(amount), id as Hex]
  );

  return generateTransactionLog({
    transactionHash,
    logIndex,
    address: to,
    data,
    topics: topics as string[],
  });
};

describe("EvmAttestationService", () => {
  it("attestEscrowDeposits - single Transfer event", async () => {
    const chains = Object.values(await getChains());

    const chain = chains[randomNumber(chains.length)];
    const transactionHash = randomHex(32);

    const from = randomHex(20);
    const token = randomHex(20);
    const amount = randomNumber(1e10).toString();

    const transferLog = generateTransferLog({
      transactionHash,
      logIndex: 0,
      from,
      to: chain.escrow,
      token,
      amount,
    });
    const transactionReceipt = generateTransactionReceipt(transactionHash, [
      transferLog,
    ]);

    (httpRpc as jest.Mock).mockImplementation(() => ({
      getTransaction: () => ({ input: "0x" }),
      getTransactionReceipt: () => transactionReceipt,
    }));

    const messages = await new EvmAttestationService().attestEscrowDeposits(
      chain.id,
      transactionHash
    );
    expect(messages.length === 1).toBeTruthy();

    const msg = messages[0] as EscrowDepositMessage;

    expect(msg.kind).toEqual("escrow-deposit");
    expect(msg.input.chainId).toEqual(chain.id);
    expect(msg.input.transactionId).toEqual(transactionHash);
    expect(msg.output.escrow).toEqual(chain.escrow);
    expect(msg.output.depositor).toEqual(from);
    expect(msg.output.currency).toEqual(token);
    expect(msg.output.amount).toEqual(amount);
    expect(msg.output.id).toBeUndefined();
  });

  it("attestEscrowDeposits - single Transfer event with id appended at the end of calldata", async () => {
    const chains = Object.values(await getChains());

    const chain = chains[randomNumber(chains.length)];
    const transactionHash = randomHex(32);

    const from = randomHex(20);
    const token = randomHex(20);
    const amount = randomNumber(1e10).toString();
    const id = randomHex(32);

    const transferLog = generateTransferLog({
      transactionHash,
      logIndex: 0,
      from,
      to: chain.escrow,
      token,
      amount,
    });
    const transactionReceipt = generateTransactionReceipt(transactionHash, [
      transferLog,
    ]);

    (httpRpc as jest.Mock).mockImplementation(() => ({
      getTransaction: () => ({
        input:
          encodeFunctionData({
            abi: ABI,
            functionName: "transfer",
            args: [chain.escrow as Hex, BigInt(amount)],
          }) + id.slice(2),
      }),
      getTransactionReceipt: () => transactionReceipt,
    }));

    const messages = await new EvmAttestationService().attestEscrowDeposits(
      chain.id,
      transactionHash
    );
    expect(messages.length === 1).toBeTruthy();

    const msg = messages[0] as EscrowDepositMessage;

    expect(msg.kind).toEqual("escrow-deposit");
    expect(msg.input.chainId).toEqual(chain.id);
    expect(msg.input.transactionId).toEqual(transactionHash);
    expect(msg.output.escrow).toEqual(chain.escrow);
    expect(msg.output.depositor).toEqual(from);
    expect(msg.output.currency).toEqual(token);
    expect(msg.output.amount).toEqual(amount);
    expect(msg.output.id).toEqual(id);
  });

  it("attestEscrowDeposits - single Transfer event with consecutive Erc20Deposit event", async () => {
    const chains = Object.values(await getChains());

    const chain = chains[randomNumber(chains.length)];
    const transactionHash = randomHex(32);

    const from = randomHex(20);
    const token = randomHex(20);
    const amount = randomNumber(1e10).toString();
    const id = randomHex(32);

    const params = {
      transactionHash,
      from,
      to: chain.escrow,
      token,
      amount,
    };

    const transferLog = generateTransferLog({ ...params, logIndex: 0 });
    const depositLog = generateErc20DepositLog({ ...params, id, logIndex: 1 });
    const transactionReceipt = generateTransactionReceipt(transactionHash, [
      transferLog,
      depositLog,
    ]);

    (httpRpc as jest.Mock).mockImplementation(() => ({
      getTransaction: () => ({ input: "0x" }),
      getTransactionReceipt: () => transactionReceipt,
    }));

    const messages = await new EvmAttestationService().attestEscrowDeposits(
      chain.id,
      transactionHash
    );
    expect(messages.length === 1).toBeTruthy();

    const msg = messages[0] as EscrowDepositMessage;

    expect(msg.kind).toEqual("escrow-deposit");
    expect(msg.input.chainId).toEqual(chain.id);
    expect(msg.input.transactionId).toEqual(transactionHash);
    expect(msg.output.escrow).toEqual(chain.escrow);
    expect(msg.output.depositor).toEqual(from);
    expect(msg.output.currency).toEqual(token);
    expect(msg.output.amount).toEqual(amount);
    expect(msg.output.id).toEqual(id);
  });

  it("attestEscrowDeposits - single Transfer event with non-consecutive Erc20Deposit event", async () => {
    const chains = Object.values(await getChains());

    const chain = chains[randomNumber(chains.length)];
    const transactionHash = randomHex(32);

    const from = randomHex(20);
    const token = randomHex(20);
    const amount = randomNumber(1e10).toString();
    const id = randomHex(32);

    const params = {
      transactionHash,
      from,
      to: chain.escrow,
      token,
      amount,
    };

    const transferLog = generateTransferLog({ ...params, logIndex: 0 });
    const depositLog = generateErc20DepositLog({ ...params, id, logIndex: 2 });
    const transactionReceipt = generateTransactionReceipt(transactionHash, [
      transferLog,
      depositLog,
    ]);

    (httpRpc as jest.Mock).mockImplementation(() => ({
      getTransaction: () => ({ input: "0x" }),
      getTransactionReceipt: () => transactionReceipt,
    }));

    const messages = await new EvmAttestationService().attestEscrowDeposits(
      chain.id,
      transactionHash
    );
    expect(messages.length === 1).toBeTruthy();

    const msg = messages[0] as EscrowDepositMessage;

    expect(msg.kind).toEqual("escrow-deposit");
    expect(msg.input.chainId).toEqual(chain.id);
    expect(msg.input.transactionId).toEqual(transactionHash);
    expect(msg.output.escrow).toEqual(chain.escrow);
    expect(msg.output.depositor).toEqual(from);
    expect(msg.output.currency).toEqual(token);
    expect(msg.output.amount).toEqual(amount);
    expect(msg.output.id).toBeUndefined();
  });

  it("attestEscrowDeposits - single Transfer event with consecutive Erc20Deposit event but without id", async () => {
    const chains = Object.values(await getChains());

    const chain = chains[randomNumber(chains.length)];
    const transactionHash = randomHex(32);

    const from = randomHex(20);
    const token = randomHex(20);
    const amount = randomNumber(1e10).toString();

    const params = {
      transactionHash,
      from,
      to: chain.escrow,
      token,
      amount,
    };

    const transferLog = generateTransferLog({ ...params, logIndex: 0 });
    const depositLog = generateErc20DepositLog({
      ...params,
      id: zeroHash,
      logIndex: 1,
    });
    const transactionReceipt = generateTransactionReceipt(transactionHash, [
      transferLog,
      depositLog,
    ]);

    (httpRpc as jest.Mock).mockImplementation(() => ({
      getTransaction: () => ({ input: "0x" }),
      getTransactionReceipt: () => transactionReceipt,
    }));

    const messages = await new EvmAttestationService().attestEscrowDeposits(
      chain.id,
      transactionHash
    );
    expect(messages.length === 1).toBeTruthy();

    const msg = messages[0] as EscrowDepositMessage;

    expect(msg.kind).toEqual("escrow-deposit");
    expect(msg.input.chainId).toEqual(chain.id);
    expect(msg.input.transactionId).toEqual(transactionHash);
    expect(msg.output.escrow).toEqual(chain.escrow);
    expect(msg.output.depositor).toEqual(from);
    expect(msg.output.currency).toEqual(token);
    expect(msg.output.amount).toEqual(amount);
    expect(msg.output.id).toBeUndefined();
  });

  it("attestEscrowDeposits - single NativeDeposit event", async () => {
    const chains = Object.values(await getChains());

    const chain = chains[randomNumber(chains.length)];
    const transactionHash = randomHex(32);

    const from = randomHex(20);
    const amount = randomNumber(1e10).toString();
    const id = randomHex(32);

    const depositLog = generateNativeDepositLog({
      transactionHash,
      logIndex: 0,
      from,
      to: chain.escrow,
      amount,
      id,
    });
    const transactionReceipt = generateTransactionReceipt(transactionHash, [
      depositLog,
    ]);

    (httpRpc as jest.Mock).mockImplementation(() => ({
      getTransaction: () => ({ input: "0x" }),
      getTransactionReceipt: () => transactionReceipt,
    }));

    const messages = await new EvmAttestationService().attestEscrowDeposits(
      chain.id,
      transactionHash
    );
    expect(messages.length === 1).toBeTruthy();

    const msg = messages[0] as EscrowDepositMessage;

    expect(msg.kind).toEqual("escrow-deposit");
    expect(msg.input.chainId).toEqual(chain.id);
    expect(msg.input.transactionId).toEqual(transactionHash);
    expect(msg.output.escrow).toEqual(chain.escrow);
    expect(msg.output.depositor).toEqual(from);
    expect(msg.output.currency).toEqual(zeroAddress);
    expect(msg.output.amount).toEqual(amount);
    expect(msg.output.id).toEqual(id);
  });

  it("attestEscrowDeposits - single NativeDeposit event without id", async () => {
    const chains = Object.values(await getChains());

    const chain = chains[randomNumber(chains.length)];
    const transactionHash = randomHex(32);

    const from = randomHex(20);
    const amount = randomNumber(1e10).toString();

    const depositLog = generateNativeDepositLog({
      transactionHash,
      logIndex: 0,
      from,
      to: chain.escrow,
      amount,
      id: zeroHash,
    });
    const transactionReceipt = generateTransactionReceipt(transactionHash, [
      depositLog,
    ]);

    (httpRpc as jest.Mock).mockImplementation(() => ({
      getTransaction: () => ({ input: "0x" }),
      getTransactionReceipt: () => transactionReceipt,
    }));

    const messages = await new EvmAttestationService().attestEscrowDeposits(
      chain.id,
      transactionHash
    );
    expect(messages.length === 1).toBeTruthy();

    const msg = messages[0] as EscrowDepositMessage;

    expect(msg.kind).toEqual("escrow-deposit");
    expect(msg.input.chainId).toEqual(chain.id);
    expect(msg.input.transactionId).toEqual(transactionHash);
    expect(msg.output.escrow).toEqual(chain.escrow);
    expect(msg.output.depositor).toEqual(from);
    expect(msg.output.currency).toEqual(zeroAddress);
    expect(msg.output.amount).toEqual(amount);
    expect(msg.output.id).toBeUndefined();
  });
});

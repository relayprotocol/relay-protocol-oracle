import { describe, expect, it } from "@jest/globals";
import {
  Hex,
  Log,
  TransactionReceipt,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
} from "viem";

import {
  ABI,
  ERC20_ABI,
  extractTransactionEntries,
} from "../../src/jobs/listen/vm/evm/utils";

import { randomHex, randomNumber } from "../common/utils";
import { chains } from "../common/chains";

const mockTransactionReceipt = (
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

const mockTransactionLog = ({
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

const mockTransferLog = ({
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

  return mockTransactionLog({
    transactionHash,
    logIndex,
    address: token,
    data,
    topics: topics as string[],
  });
};

const mockErc20DepositLog = ({
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

  return mockTransactionLog({
    transactionHash,
    logIndex,
    address: to,
    data,
    topics: topics as string[],
  });
};

describe("evm-extract-transaction-entries", () => {
  it("single erc20 transfer event", async () => {
    const chain = chains[randomNumber(chains.length)];
    const transactionHash = randomHex(32);

    const from = randomHex(20);
    const token = randomHex(20);
    const amount = randomNumber(1e10).toString();

    const transferLog = mockTransferLog({
      transactionHash,
      logIndex: 0,
      from,
      to: chain.metadata!.escrow!,
      token,
      amount,
    });
    const transactionReceipt = mockTransactionReceipt(transactionHash, [
      transferLog,
    ]);

    const transactionEntries = await extractTransactionEntries(
      chain.id,
      transactionReceipt,
      () =>
        ({
          input: "0x",
        } as any)
    );
    expect(transactionEntries.length === 1).toBeTruthy();

    const te = transactionEntries[0];

    expect(te.chainId === chain.id).toBeTruthy();
    expect(te.transactionId === transactionHash).toBeTruthy();
    expect(te.entryId === "0").toBeTruthy();
    expect(
      te.data.type === "deposit" && te.data.data.depositorAddress === from
    ).toBeTruthy();
    expect(te.data.data.currencyAddress === token).toBeTruthy();
    expect(te.data.data.amount === amount).toBeTruthy();
    expect(
      te.data.type === "deposit" && te.data.data.depositId === undefined
    ).toBeTruthy();
  });

  it("single erc20 transfer event with id appended at the end of calldata", async () => {
    const chain = chains[randomNumber(chains.length)];
    const transactionHash = randomHex(32);

    const from = randomHex(20);
    const token = randomHex(20);
    const amount = randomNumber(1e10).toString();

    const transferLog = mockTransferLog({
      transactionHash,
      logIndex: 0,
      from,
      to: chain.metadata!.escrow!,
      token,
      amount,
    });
    const transactionReceipt = mockTransactionReceipt(transactionHash, [
      transferLog,
    ]);

    const id = randomHex(32);
    const transactionEntries = await extractTransactionEntries(
      chain.id,
      transactionReceipt,
      () =>
        ({
          input:
            encodeFunctionData({
              abi: ERC20_ABI,
              functionName: "transfer",
              args: [chain.metadata!.escrow! as Hex, BigInt(amount)],
            }) + id.slice(2),
        } as any)
    );
    expect(transactionEntries.length === 1).toBeTruthy();

    const te = transactionEntries[0];

    expect(te.chainId === chain.id).toBeTruthy();
    expect(te.transactionId === transactionHash).toBeTruthy();
    expect(te.entryId === "0").toBeTruthy();
    expect(
      te.data.type === "deposit" && te.data.data.depositorAddress === from
    ).toBeTruthy();
    expect(te.data.data.currencyAddress === token).toBeTruthy();
    expect(te.data.data.amount === amount).toBeTruthy();
    expect(
      te.data.type === "deposit" && te.data.data.depositId === id
    ).toBeTruthy();
  });

  it("erc20 transfer event coupled with deposit event", async () => {
    const chain = chains[randomNumber(chains.length)];
    const transactionHash = randomHex(32);

    const from = randomHex(20);
    const token = randomHex(20);
    const amount = randomNumber(1e10).toString();

    const params = {
      transactionHash,
      from,
      to: chain.metadata!.escrow!,
      token,
      amount,
    };

    const id = randomHex(32);
    const transferLog = mockTransferLog({ ...params, logIndex: 0 });
    const depositLog = mockErc20DepositLog({ ...params, id, logIndex: 1 });
    const transactionReceipt = mockTransactionReceipt(transactionHash, [
      transferLog,
      depositLog,
    ]);

    const transactionEntries = await extractTransactionEntries(
      chain.id,
      transactionReceipt,
      () =>
        ({
          input: "0x",
        } as any)
    );
    expect(transactionEntries.length === 1).toBeTruthy();

    const te = transactionEntries[0];

    expect(te.chainId === chain.id).toBeTruthy();
    expect(te.transactionId === transactionHash).toBeTruthy();
    expect(te.entryId === "0").toBeTruthy();
    expect(
      te.data.type === "deposit" && te.data.data.depositorAddress === from
    ).toBeTruthy();
    expect(te.data.data.currencyAddress === token).toBeTruthy();
    expect(te.data.data.amount === amount).toBeTruthy();
    expect(
      te.data.type === "deposit" && te.data.data.depositId === id
    ).toBeTruthy();
  });

  it("erc20 transfer event coupled with deposit event but not consecutive log indexes", async () => {
    const chain = chains[randomNumber(chains.length)];
    const transactionHash = randomHex(32);

    const from = randomHex(20);
    const token = randomHex(20);
    const amount = randomNumber(1e10).toString();

    const params = {
      transactionHash,
      from,
      to: chain.metadata!.escrow!,
      token,
      amount,
    };

    const id = randomHex(32);
    const transferLog = mockTransferLog({ ...params, logIndex: 0 });
    const depositLog = mockErc20DepositLog({ ...params, id, logIndex: 2 });
    const transactionReceipt = mockTransactionReceipt(transactionHash, [
      transferLog,
      depositLog,
    ]);

    const transactionEntries = await extractTransactionEntries(
      chain.id,
      transactionReceipt,
      () =>
        ({
          input: "0x",
        } as any)
    );
    expect(transactionEntries.length === 1).toBeTruthy();

    const te = transactionEntries[0];

    expect(te.chainId === chain.id).toBeTruthy();
    expect(te.transactionId === transactionHash).toBeTruthy();
    expect(te.entryId === "0").toBeTruthy();
    expect(
      te.data.type === "deposit" && te.data.data.depositorAddress === from
    ).toBeTruthy();
    expect(te.data.data.currencyAddress === token).toBeTruthy();
    expect(te.data.data.amount === amount).toBeTruthy();
    expect(
      te.data.type === "deposit" && te.data.data.depositId === undefined
    ).toBeTruthy();
  });
});

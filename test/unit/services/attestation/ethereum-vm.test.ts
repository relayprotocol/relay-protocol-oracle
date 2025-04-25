import { describe, expect, it, jest } from "@jest/globals";
import { getOrderHash, Order } from "@reservoir0x/relay-protocol-sdk";
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
import { privateKeyToAccount } from "viem/accounts";

import { randomHex, randomNumber } from "../../../common/utils";

import { getChains } from "../../../../src/common/chains";
import { httpRpc } from "../../../../src/common/vm/ethereum-vm/rpc";
import { AttestationService } from "../../../../src/services/attestation";
import { ABI } from "../../../../src/services/attestation/vm/ethereum-vm";

const testSolverPrivateKey =
  "0x1234567890123456789012345678901234567890123456789012345678901234";
const solverWallet = privateKeyToAccount(testSolverPrivateKey);

jest.mock("../../../../src/common/chains", () => {
  const chains: Record<number, any> = {
    1000: {
      id: 1000,
      name: "Test",
      vmType: "ethereum-vm",
      httpRpcUrl: "http://127.0.0.1:8545",
      escrow: "0x2e988a386a799f506693793c6a5af6b54dfaabfb",
    },
  };
  return {
    getChains: () => chains,
    getChain: (chainId: number) => chains[chainId],
    getSdkChainsConfig: () => ({ 1000: "ethereum-vm" }),
  };
});
jest.mock("../../../../src/common/vm/ethereum-vm/rpc", () => {
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
    eventName: "EscrowNativeDeposit",
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
    eventName: "EscrowErc20Deposit",
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

const generateSolverNativeTransferLog = ({
  transactionHash,
  logIndex,
  from,
  to: solverContract,
  amount,
}: {
  transactionHash: string;
  logIndex: number;
  from: string;
  to: string;
  amount: string;
}) => {
  const topics = encodeEventTopics({
    abi: ABI,
    eventName: "SolverNativeTransfer",
  });
  const data = encodeAbiParameters(
    [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    [from as Hex, BigInt(amount)]
  );

  return generateTransactionLog({
    transactionHash,
    logIndex,
    address: solverContract,
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

    const messages = await new AttestationService().attestEscrowDeposits({
      chainId: chain.id,
      transactionId: transactionHash,
    });
    expect(messages.length === 1).toBeTruthy();

    const msg = messages[0];

    expect(msg.data.chainId).toEqual(chain.id);
    expect(msg.data.transactionId).toEqual(transactionHash);
    expect(msg.result.escrow).toEqual(chain.escrow);
    expect(msg.result.depositor).toEqual(from);
    expect(msg.result.currency).toEqual(token);
    expect(msg.result.amount).toEqual(amount);
    expect(msg.result.depositId).toEqual(zeroHash);
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

    const messages = await new AttestationService().attestEscrowDeposits({
      chainId: chain.id,
      transactionId: transactionHash,
    });
    expect(messages.length === 1).toBeTruthy();

    const msg = messages[0];

    expect(msg.data.chainId).toEqual(chain.id);
    expect(msg.data.transactionId).toEqual(transactionHash);
    expect(msg.result.escrow).toEqual(chain.escrow);
    expect(msg.result.depositor).toEqual(from);
    expect(msg.result.currency).toEqual(token);
    expect(msg.result.amount).toEqual(amount);
    expect(msg.result.depositId).toEqual(id);
  });

  it("attestEscrowDeposits - single Transfer event with consecutive EscrowErc20Deposit event", async () => {
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

    const messages = await new AttestationService().attestEscrowDeposits({
      chainId: chain.id,
      transactionId: transactionHash,
    });
    expect(messages.length === 1).toBeTruthy();

    const msg = messages[0];

    expect(msg.data.chainId).toEqual(chain.id);
    expect(msg.data.transactionId).toEqual(transactionHash);
    expect(msg.result.escrow).toEqual(chain.escrow);
    expect(msg.result.depositor).toEqual(from);
    expect(msg.result.currency).toEqual(token);
    expect(msg.result.amount).toEqual(amount);
    expect(msg.result.depositId).toEqual(id);
  });

  it("attestEscrowDeposits - single Transfer event with non-consecutive EscrowErc20Deposit event", async () => {
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

    const messages = await new AttestationService().attestEscrowDeposits({
      chainId: chain.id,
      transactionId: transactionHash,
    });
    expect(messages.length === 1).toBeTruthy();

    const msg = messages[0];

    expect(msg.data.chainId).toEqual(chain.id);
    expect(msg.data.transactionId).toEqual(transactionHash);
    expect(msg.result.escrow).toEqual(chain.escrow);
    expect(msg.result.depositor).toEqual(from);
    expect(msg.result.currency).toEqual(token);
    expect(msg.result.amount).toEqual(amount);
    expect(msg.result.depositId).toEqual(zeroHash);
  });

  it("attestEscrowDeposits - single Transfer event with consecutive EscrowErc20Deposit event but without id", async () => {
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

    const messages = await new AttestationService().attestEscrowDeposits({
      chainId: chain.id,
      transactionId: transactionHash,
    });
    expect(messages.length === 1).toBeTruthy();

    const msg = messages[0];

    expect(msg.data.chainId).toEqual(chain.id);
    expect(msg.data.transactionId).toEqual(transactionHash);
    expect(msg.result.escrow).toEqual(chain.escrow);
    expect(msg.result.depositor).toEqual(from);
    expect(msg.result.currency).toEqual(token);
    expect(msg.result.amount).toEqual(amount);
    expect(msg.result.depositId).toEqual(zeroHash);
  });

  it("attestEscrowDeposits - single EscrowNativeDeposit event", async () => {
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

    const messages = await new AttestationService().attestEscrowDeposits({
      chainId: chain.id,
      transactionId: transactionHash,
    });
    expect(messages.length === 1).toBeTruthy();

    const msg = messages[0];

    expect(msg.data.chainId).toEqual(chain.id);
    expect(msg.data.transactionId).toEqual(transactionHash);
    expect(msg.result.escrow).toEqual(chain.escrow);
    expect(msg.result.depositor).toEqual(from);
    expect(msg.result.currency).toEqual(zeroAddress);
    expect(msg.result.amount).toEqual(amount);
    expect(msg.result.depositId).toEqual(id);
  });

  it("attestEscrowDeposits - single EscrowNativeDeposit event without id", async () => {
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

    const messages = await new AttestationService().attestEscrowDeposits({
      chainId: chain.id,
      transactionId: transactionHash,
    });
    expect(messages.length === 1).toBeTruthy();

    const msg = messages[0];

    expect(msg.data.chainId).toEqual(chain.id);
    expect(msg.data.transactionId).toEqual(transactionHash);
    expect(msg.result.escrow).toEqual(chain.escrow);
    expect(msg.result.depositor).toEqual(from);
    expect(msg.result.currency).toEqual(zeroAddress);
    expect(msg.result.amount).toEqual(amount);
    expect(msg.result.depositId).toEqual(zeroHash);
  });

  it("attestSolverFill - validates solver fill correctly", async () => {
    const chains = Object.values(await getChains());
    const currentTimestamp = Math.floor(Date.now() / 1000);

    const chain = chains[randomNumber(chains.length)];
    const depositTxHash = randomHex(32);
    const fillTxHash = randomHex(32);

    const depositorAddress = randomHex(20);
    const tokenAddress = randomHex(20);
    const paymentAmount = randomNumber(1e10).toString();
    const outputRecipient = randomHex(20);
    const solverContractAddress = randomHex(20);

    const depositTransferLog = generateTransferLog({
      transactionHash: depositTxHash,
      logIndex: 0,
      from: depositorAddress,
      to: chain.escrow,
      token: tokenAddress,
      amount: paymentAmount,
    });
    const depositTxReceipt = generateTransactionReceipt(depositTxHash, [
      depositTransferLog,
    ]);

    const fillNativeTransferLog = generateSolverNativeTransferLog({
      transactionHash: fillTxHash,
      logIndex: 0,
      from: outputRecipient,
      to: solverContractAddress,
      amount: paymentAmount,
    });

    const fillTxReceipt = generateTransactionReceipt(fillTxHash, [
      fillNativeTransferLog,
    ]);

    const vmType = "ethereum-vm";
    const testOrder: Order = {
      salt: "0x1",
      solver: {
        chainId: 1000,
        address: solverWallet.address,
      },
      inputs: [
        {
          payment: {
            chainId: 1000,
            currency: zeroAddress,
            amount: paymentAmount,
            weight: "1",
          },
          refunds: [
            {
              chainId: 1000,
              recipient: randomHex(20),
              currency: zeroAddress,
              minimumAmount: paymentAmount,
              deadline: Math.floor(Date.now() / 1000) + 3600,
              extraData: encodeAbiParameters(
                [{ type: "address" }],
                [solverContractAddress as Hex]
              ),
            },
          ],
        },
      ],
      output: {
        chainId: 1000,
        payments: [
          {
            recipient: outputRecipient,
            currency: zeroAddress,
            minimumAmount: paymentAmount,
            expectedAmount: paymentAmount,
          },
        ],
        calls: [],
        extraData: encodeAbiParameters(
          [{ type: "address" }],
          [solverContractAddress as Hex]
        ),
        deadline: Math.floor(Date.now() / 1000) + 3600,
      },
      fees: [],
    };

    const orderHash = getOrderHash(testOrder, {
      1000: vmType,
    });

    const mockRpcData = {
      transactions: {
        [depositTxHash]: {
          input: "0x",
          receipt: depositTxReceipt,
        },
        [fillTxHash]: {
          input: orderHash,
          receipt: fillTxReceipt,
        },
      },
      block: {
        timestamp: BigInt(currentTimestamp),
        hash: randomHex(32),
        parentHash: randomHex(32),
      },
    };

    (httpRpc as jest.Mock).mockImplementation(() => ({
      getTransaction: ({ hash }: { hash: string }) => {
        const txData = mockRpcData.transactions[hash];
        if (!txData) {
          throw new Error(`Invalid transaction ID: ${hash}`);
        }
        return { input: txData.input };
      },
      getTransactionReceipt: ({ hash }: { hash: string }) => {
        const txData = mockRpcData.transactions[hash];
        if (!txData) {
          throw new Error(`Invalid transaction ID: ${hash}`);
        }
        return txData.receipt;
      },
      getBlock: ({ blockNumber }: { blockNumber: bigint }) => {
        return Promise.resolve({
          ...mockRpcData.block,
          number: blockNumber,
        });
      },
    }));

    const orderSignature = await solverWallet.signMessage({
      message: { raw: orderHash },
    });

    const escrowDeposits = await new AttestationService().attestEscrowDeposits({
      chainId: chain.id,
      transactionId: depositTxHash,
    });

    const solverFillResult = await new AttestationService().attestSolverFill({
      order: testOrder,
      orderSignature: orderSignature,
      inputs: [
        {
          transactionId: depositTxHash,
          onchainId: escrowDeposits[0].onchainId,
          inputIndex: 0,
        },
      ],
      fill: {
        transactionId: fillTxHash,
      },
    });

    expect(solverFillResult.result.validated).toBe(true);
    expect(solverFillResult.result.totalWeightedInputPaymentBpsDiff).toBe("0");
  });

  it("attestSolverRefund - validates solver refund correctly", async () => {
    const chains = Object.values(await getChains());
    const currentTimestamp = Math.floor(Date.now() / 1000);

    const chain = chains[randomNumber(chains.length)];
    const depositTxHash = randomHex(32);

    const depositorAddress = randomHex(20);
    const tokenAddress = randomHex(20);
    const paymentAmount = randomNumber(1e10).toString();
    const outputRecipient = randomHex(20);
    const refundRecipient = randomHex(20);
    const solverContractAddress = randomHex(20);

    const depositTransferLog = generateTransferLog({
      transactionHash: depositTxHash,
      logIndex: 0,
      from: depositorAddress,
      to: chain.escrow,
      token: tokenAddress,
      amount: paymentAmount,
    });
    const depositTxReceipt = generateTransactionReceipt(depositTxHash, [
      depositTransferLog,
    ]);

    const refundTxHash = randomHex(32);
    const refundNativeTransferLog = generateSolverNativeTransferLog({
      transactionHash: refundTxHash,
      logIndex: 0,
      from: refundRecipient,
      to: solverContractAddress,
      amount: paymentAmount,
    });

    const refundTxReceipt = generateTransactionReceipt(refundTxHash, [
      refundNativeTransferLog,
    ]);

    const vmType = "ethereum-vm";
    const testOrder: Order = {
      salt: "0x1",
      solver: {
        chainId: 1000,
        address: solverWallet.address,
      },
      inputs: [
        {
          payment: {
            chainId: 1000,
            currency: zeroAddress,
            amount: paymentAmount,
            weight: "1",
          },
          refunds: [
            {
              chainId: 1000,
              recipient: refundRecipient,
              currency: zeroAddress,
              minimumAmount: paymentAmount,
              deadline: Math.floor(Date.now() / 1000) + 36000,
              extraData: encodeAbiParameters(
                [{ type: "address" }],
                [solverContractAddress as Hex]
              ),
            },
          ],
        },
      ],
      output: {
        chainId: 1000,
        payments: [
          {
            recipient: outputRecipient,
            currency: zeroAddress,
            minimumAmount: paymentAmount,
            expectedAmount: paymentAmount,
          },
        ],
        calls: [],
        extraData: encodeAbiParameters(
          [{ type: "address" }],
          [solverContractAddress as Hex]
        ),
        deadline: Math.floor(Date.now() / 1000) + 36000,
      },
      fees: [],
    };

    const orderHash = getOrderHash(testOrder, {
      1000: vmType,
    });

    const mockRpcData = {
      transactions: {
        [depositTxHash]: {
          input: "0x",
          receipt: depositTxReceipt,
        },
        [refundTxHash]: {
          input: orderHash,
          receipt: refundTxReceipt,
        },
      },
      block: {
        timestamp: BigInt(currentTimestamp),
        hash: randomHex(32),
        parentHash: randomHex(32),
      },
    };

    (httpRpc as jest.Mock).mockImplementation(() => ({
      getTransaction: ({ hash }: { hash: string }) => {
        const txData = mockRpcData.transactions[hash];
        if (!txData) {
          throw new Error(`Invalid transaction ID: ${hash}`);
        }
        return { input: txData.input };
      },
      getTransactionReceipt: ({ hash }: { hash: string }) => {
        const txData = mockRpcData.transactions[hash];
        if (!txData) {
          throw new Error(`Invalid transaction ID: ${hash}`);
        }
        return txData.receipt;
      },
      getBlock: ({ blockNumber }: { blockNumber: bigint }) => {
        return Promise.resolve({
          ...mockRpcData.block,
          number: blockNumber,
        });
      },
    }));

    const orderSignature = await solverWallet.signMessage({
      message: { raw: orderHash },
    });

    const escrowDeposits = await new AttestationService().attestEscrowDeposits({
      chainId: chain.id,
      transactionId: depositTxHash,
    });

    const solverRefundResult =
      await new AttestationService().attestSolverRefund({
        order: testOrder,
        orderSignature: orderSignature,
        inputs: [
          {
            transactionId: depositTxHash,
            onchainId: escrowDeposits[0].onchainId,
            inputIndex: 0,
          },
        ],
        refunds: [
          {
            transactionId: refundTxHash,
            inputIndex: 0,
            refundIndex: 0,
          },
        ],
      });

    expect(solverRefundResult.result.validated).toBe(true);
    expect(solverRefundResult.result.totalWeightedInputPaymentBpsDiff).toBe(
      "0"
    );
  });
});

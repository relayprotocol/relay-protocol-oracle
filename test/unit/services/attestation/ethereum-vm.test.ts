import { describe, expect, it, jest } from "@jest/globals";
import {
  decodeWithdrawal,
  encodeWithdrawal,
  DepositoryWithdrawalStatus,
  encodeOrderCall,
  encodeOrderExtraData,
  getOrderId,
  Order,
  SolverFillStatus,
  SolverRefundStatus,
} from "@relay-protocol/settlement-sdk";
import {
  Hex,
  Log,
  TransactionReceipt,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  getContract,
  zeroAddress,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  Chain,
  getChains,
  getSdkChainsConfig,
} from "../../../../src/common/chains";
import { httpRpc } from "../../../../src/common/vm/ethereum-vm/rpc";
import { AttestationService } from "../../../../src/services/attestation";
import {
  ABI,
  EthereumVmAttestor,
} from "../../../../src/services/attestation/vm/ethereum-vm";

import { ONE_BILLION, randomHex, randomNumber } from "../../../common/utils";
import { createMockWithdrawalAddressRequest } from "../../../common/withdrawals";

const testSolverPrivateKey =
  "0x1234567890123456789012345678901234567890123456789012345678901234";
const solverWallet = privateKeyToAccount(testSolverPrivateKey);

jest.mock("../../../../src/common/chains", () => {
  const chains: Record<string, Chain> = {
    ethereum: {
      id: "ethereum",
      vmType: "ethereum-vm",
      httpRpcUrl: "http://127.0.0.1:8545",
      depository: "0x2e988a386a799f506693793c6a5af6b54dfaabfb",
      hubChainId: "1",
    },
  };
  return {
    HUB_VM_TYPE: "hub-vm",
    HUB_CHAIN_ID: 0n,
    getChains: async () => chains,
    getHubInfo: async () => ({
      id: "hub",
      evmChainId: "1",
      httpRpcUrl: "http://localhost:8545",
      hubAddress: "0x0000000000000000000000000000000000000001",
      oracleAddress: "0x0000000000000000000000000000000000000002",
      oracleMultisigAddress: "0x0000000000000000000000000000000000000003",
      genericMappingAddress: "0x0000000000000000000000000000000000000004",
      auroraHttpRpcUrl: "http://localhost:8545",
      auroraEvmChainId: "1313161554",
      auroraAllocatorAddress: "0x0000000000000000000000000000000000000005",
      auroraAllocatorSpenderAddress: "0x0000000000000000000000000000000000000006",
      auroraOracleMultisigAddress: "0x0000000000000000000000000000000000000007",
    }),
    getChain: async (chainId: string) => chains[chainId],
    getChainVmType: async (chainId: string) =>
      chainId === "base" ? "ethereum-vm" : chains[chainId].vmType,
    getChainHubChainId: async (chainId: string) =>
      chainId === "base" ? "8453" : chains[chainId].hubChainId,
    getSdkChainsConfig: () =>
      Object.fromEntries(
        Object.values(chains).map((chain) => [chain.id, chain.vmType])
      ),
  };
});
jest.mock("../../../../src/common/vm/ethereum-vm/rpc", () => {
  return {
    httpRpc: jest.fn(),
  };
});
jest.mock("viem", () => {
  return {
    ...(jest.requireActual("viem") as typeof import("viem")),
    getContract: jest.fn(),
  };
});
jest.mock("@relay-protocol/settlement-sdk", () => {
  const original = jest.requireActual("@relay-protocol/settlement-sdk");
  return {
    ...(original as any),
    getDecodedWithdrawalAmount: jest.fn().mockReturnValue(1000),
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
    eventName: "RelayNativeDeposit",
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
    eventName: "RelayErc20Deposit",
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

const generateSolverCallExecutedLog = ({
  transactionHash,
  logIndex,
  fillContract,
  to,
  data: callData,
  amount,
}: {
  transactionHash: string;
  logIndex: number;
  fillContract: string;
  to: string;
  data: string;
  amount: string;
}) => {
  const topics = encodeEventTopics({
    abi: ABI,
    eventName: "SolverCallExecuted",
  });
  const data = encodeAbiParameters(
    [
      { name: "to", type: "address" },
      { name: "data", type: "bytes" },
      { name: "amount", type: "uint256" },
    ],
    [to as Hex, callData as Hex, BigInt(amount)]
  );

  return generateTransactionLog({
    transactionHash,
    logIndex,
    address: fillContract,
    data,
    topics: topics as string[],
  });
};

// Create a standard test Order object
function createTestOrder({
  paymentAmount,
  outputRecipient,
  refundRecipient,
  solverContractAddress,
  solverAddress,
  inputCurrency = zeroAddress,
  outputCurrency = zeroAddress,
}: {
  paymentAmount: string;
  outputRecipient: string;
  refundRecipient: string;
  solverContractAddress: string;
  solverAddress: string;
  inputCurrency?: string;
  outputCurrency?: string;
}): Order {
  return {
    version: "v1",
    salt: "0x1",
    solverChainId: "ethereum",
    solver: solverAddress,
    inputs: [
      {
        payment: {
          chainId: "ethereum",
          currency: inputCurrency,
          amount: paymentAmount,
          weight: "1",
        },
        refunds: [
          {
            chainId: "ethereum",
            recipient: refundRecipient,
            currency: inputCurrency,
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
      chainId: "ethereum",
      payments: [
        {
          recipient: outputRecipient,
          currency: outputCurrency,
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
}

// Setup common test data
interface TestSetupParams {
  chain: any;
  currentTimestamp: number;
  depositorAddress: string;
  tokenAddress: string;
  paymentAmount: string;
  outputRecipient: string;
  refundRecipient: string;
  solverContractAddress: string;
}

function setupTestData(): TestSetupParams {
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const depositorAddress = randomHex(20);
  const tokenAddress = randomHex(20);
  const paymentAmount = randomNumber(1e10).toString();
  const outputRecipient = randomHex(20);
  const refundRecipient = randomHex(20);
  const solverContractAddress = randomHex(20);

  return {
    chain: null, // Will be set at call site
    currentTimestamp,
    depositorAddress,
    tokenAddress,
    paymentAmount,
    outputRecipient,
    refundRecipient,
    solverContractAddress,
  };
}

// Create deposit transaction logs
function createNativeDepositTransaction(params: {
  depositTxHash: string;
  depositorAddress: string;
  depositoryAddress: string;
  paymentAmount: string;
  depositId?: string;
}) {
  const {
    depositTxHash,
    depositorAddress,
    depositoryAddress,
    paymentAmount,
    depositId,
  } = params;

  const depositTransferLog = generateNativeDepositLog({
    transactionHash: depositTxHash,
    logIndex: 0,
    from: depositorAddress,
    to: depositoryAddress,
    amount: paymentAmount,
    id: depositId ?? zeroHash,
  });

  return generateTransactionReceipt(depositTxHash, [depositTransferLog]);
}

// Create fill transaction logs
function createFillTransaction(params: {
  fillTxHash: string;
  outputRecipient: string;
  solverContractAddress: string;
  paymentAmount: string;
}) {
  const { fillTxHash, outputRecipient, solverContractAddress, paymentAmount } =
    params;

  const fillNativeTransferLog = generateSolverNativeTransferLog({
    transactionHash: fillTxHash,
    logIndex: 0,
    from: outputRecipient,
    to: solverContractAddress,
    amount: paymentAmount,
  });

  return generateTransactionReceipt(fillTxHash, [fillNativeTransferLog]);
}

// Create refund transaction logs
function createRefundTransaction(params: {
  refundTxHash: string;
  refundRecipient: string;
  solverContractAddress: string;
  paymentAmount: string;
}) {
  const {
    refundTxHash,
    refundRecipient,
    solverContractAddress,
    paymentAmount,
  } = params;

  const refundNativeTransferLog = generateSolverNativeTransferLog({
    transactionHash: refundTxHash,
    logIndex: 0,
    from: refundRecipient,
    to: solverContractAddress,
    amount: paymentAmount,
  });

  return generateTransactionReceipt(refundTxHash, [refundNativeTransferLog]);
}

function setupRpcMock(mockData: any) {
  (httpRpc as jest.Mock).mockImplementation(() => ({
    getTransaction: async ({ hash }: { hash: string }) => {
      const txData = mockData.transactions[hash];
      return { input: txData.input };
    },
    getTransactionReceipt: async ({ hash }: { hash: string }) => {
      const txData = mockData.transactions[hash];
      return txData.receipt;
    },
    getBlock: getBlockMock,
  }));
}

const getBlockMock = async (data?: any) => {
  const now = Math.floor(Date.now() / 1000);
  if (!data || data.blockTag === "latest") {
    return { number: BigInt(1e12), timestamp: BigInt(now + 60 * 2) };
  } else {
    return { number: data.blockNumber, timestamp: BigInt(now) };
  }
};

describe("EthereumVmAttestor", () => {
  it("attestDepositoryDeposits - single Transfer event", async () => {
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
      to: chain.depository!,
      token,
      amount,
    });
    const transactionReceipt = generateTransactionReceipt(transactionHash, [
      transferLog,
    ]);

    (httpRpc as jest.Mock).mockImplementation(() => ({
      getBlock: getBlockMock,
      getTransaction: async () => ({ input: "0x" }),
      getTransactionReceipt: async () => transactionReceipt,
    }));

    const { messages } =
      await new AttestationService().attestDepositoryDeposits({
        chainId: chain.id,
        transactionId: transactionHash,
      });
    expect(messages.length === 1).toBeTruthy();

    const msg = messages[0];

    expect(msg.data.chainId).toEqual(chain.id);
    expect(msg.data.transactionId).toEqual(transactionHash);
    expect(msg.result.depositor).toEqual(from);
    expect(msg.result.depository).toEqual(chain.depository);
    expect(msg.result.currency).toEqual(token);
    expect(msg.result.amount).toEqual(amount);
    expect(msg.result.depositId).toEqual(zeroHash);
  });

  it("attestDepositoryDeposits - single Transfer event with id appended at the end of calldata", async () => {
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
      to: chain.depository!,
      token,
      amount,
    });
    const transactionReceipt = generateTransactionReceipt(transactionHash, [
      transferLog,
    ]);

    (httpRpc as jest.Mock).mockImplementation(() => ({
      getBlock: getBlockMock,
      getTransaction: async () => ({
        input:
          encodeFunctionData({
            abi: ABI,
            functionName: "transfer",
            args: [chain.depository as Hex, BigInt(amount)],
          }) + id.slice(2),
      }),
      getTransactionReceipt: async () => transactionReceipt,
    }));

    const { messages } =
      await new AttestationService().attestDepositoryDeposits({
        chainId: chain.id,
        transactionId: transactionHash,
      });
    expect(messages.length === 1).toBeTruthy();

    const msg = messages[0];

    expect(msg.data.chainId).toEqual(chain.id);
    expect(msg.data.transactionId).toEqual(transactionHash);
    expect(msg.result.depositor).toEqual(from);
    expect(msg.result.depository).toEqual(chain.depository);
    expect(msg.result.currency).toEqual(token);
    expect(msg.result.amount).toEqual(amount);
    expect(msg.result.depositId).toEqual(id);
  });

  it("attestDepositoryDeposits - single Transfer event with zero-prefix id appended at the end of calldata", async () => {
    const chains = Object.values(await getChains());

    const chain = chains[randomNumber(chains.length)];
    const transactionHash = randomHex(32);

    const from = randomHex(20);
    const token = randomHex(20);
    const amount = randomNumber(1e10).toString();
    // An id that starts with the zero hash prefix (first 16 bytes are zeros)
    const zeroishId =
      zeroHash.slice(0, 34) +
      "abcdef1234567890abcdef1234567890";

    const transferLog = generateTransferLog({
      transactionHash,
      logIndex: 0,
      from,
      to: chain.depository!,
      token,
      amount,
    });
    const transactionReceipt = generateTransactionReceipt(transactionHash, [
      transferLog,
    ]);

    (httpRpc as jest.Mock).mockImplementation(() => ({
      getBlock: getBlockMock,
      getTransaction: async () => ({
        input:
          encodeFunctionData({
            abi: ABI,
            functionName: "transfer",
            args: [chain.depository as Hex, BigInt(amount)],
          }) + zeroishId.slice(2),
      }),
      getTransactionReceipt: async () => transactionReceipt,
    }));

    const { messages } =
      await new AttestationService().attestDepositoryDeposits({
        chainId: chain.id,
        transactionId: transactionHash,
      });
    expect(messages.length === 1).toBeTruthy();

    const msg = messages[0];

    expect(msg.data.chainId).toEqual(chain.id);
    expect(msg.data.transactionId).toEqual(transactionHash);
    expect(msg.result.depositor).toEqual(from);
    expect(msg.result.depository).toEqual(chain.depository);
    expect(msg.result.currency).toEqual(token);
    expect(msg.result.amount).toEqual(amount);
    // Zero-prefix id should be ignored, falling back to zeroHash
    expect(msg.result.depositId).toEqual(zeroHash);
  });

  it("attestDepositoryDeposits - single Transfer event with full zero hash id appended at the end of calldata", async () => {
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
      to: chain.depository!,
      token,
      amount,
    });
    const transactionReceipt = generateTransactionReceipt(transactionHash, [
      transferLog,
    ]);

    (httpRpc as jest.Mock).mockImplementation(() => ({
      getBlock: getBlockMock,
      getTransaction: async () => ({
        input:
          encodeFunctionData({
            abi: ABI,
            functionName: "transfer",
            args: [chain.depository as Hex, BigInt(amount)],
          }) + zeroHash.slice(2),
      }),
      getTransactionReceipt: async () => transactionReceipt,
    }));

    const { messages } =
      await new AttestationService().attestDepositoryDeposits({
        chainId: chain.id,
        transactionId: transactionHash,
      });
    expect(messages.length === 1).toBeTruthy();

    const msg = messages[0];

    expect(msg.data.chainId).toEqual(chain.id);
    expect(msg.data.transactionId).toEqual(transactionHash);
    expect(msg.result.depositor).toEqual(from);
    expect(msg.result.depository).toEqual(chain.depository);
    expect(msg.result.currency).toEqual(token);
    expect(msg.result.amount).toEqual(amount);
    // Full zero hash id should be ignored, falling back to zeroHash
    expect(msg.result.depositId).toEqual(zeroHash);
  });

  it("attestDepositoryDeposits - Transfer event with consecutive RelayErc20Deposit event", async () => {
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
      to: chain.depository!,
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
      getBlock: getBlockMock,
      getTransaction: async () => ({ input: "0x" }),
      getTransactionReceipt: async () => transactionReceipt,
    }));

    const { messages } =
      await new AttestationService().attestDepositoryDeposits({
        chainId: chain.id,
        transactionId: transactionHash,
      });
    expect(messages.length === 1).toBeTruthy();

    const msg = messages[0];

    expect(msg.data.chainId).toEqual(chain.id);
    expect(msg.data.transactionId).toEqual(transactionHash);
    expect(msg.result.depositor).toEqual(from);
    expect(msg.result.depository).toEqual(chain.depository);
    expect(msg.result.currency).toEqual(token);
    expect(msg.result.amount).toEqual(amount);
    expect(msg.result.depositId).toEqual(id);
  });

  it("attestDepositoryDeposits - direct deposit bundled with explicit deposit", async () => {
    const chains = Object.values(await getChains());

    const chain = chains[randomNumber(chains.length)];
    const transactionHash = randomHex(32);

    const depositor = randomHex(20);
    const from = randomHex(20);
    const token = randomHex(20);
    const amount = randomNumber(1e10).toString();
    const id = randomHex(32);

    const params = {
      transactionHash,
      from,
      to: chain.depository!,
      token,
      amount,
    };

    const firstTransferLog = generateTransferLog({ ...params, logIndex: 0 });
    const secondTransferLog = generateTransferLog({ ...params, logIndex: 1 });
    const depositLog = generateErc20DepositLog({
      ...params,
      id,
      from: depositor,
      logIndex: 3,
    });
    const transactionReceipt = generateTransactionReceipt(transactionHash, [
      firstTransferLog,
      secondTransferLog,
      depositLog,
    ]);

    (httpRpc as jest.Mock).mockImplementation(() => ({
      getBlock: getBlockMock,
      getTransaction: async () => ({ input: "0x" }),
      getTransactionReceipt: async () => transactionReceipt,
    }));

    const { messages } =
      await new AttestationService().attestDepositoryDeposits({
        chainId: chain.id,
        transactionId: transactionHash,
      });
    expect(messages.length === 2).toBeTruthy();

    const firstMsg = messages[0];
    expect(firstMsg.data.chainId).toEqual(chain.id);
    expect(firstMsg.data.transactionId).toEqual(transactionHash);
    expect(firstMsg.result.depositor).toEqual(from);
    expect(firstMsg.result.depository).toEqual(chain.depository);
    expect(firstMsg.result.currency).toEqual(token);
    expect(firstMsg.result.amount).toEqual(amount);
    expect(firstMsg.result.depositId).toEqual(zeroHash);

    const secondMsg = messages[1];
    expect(secondMsg.data.chainId).toEqual(chain.id);
    expect(secondMsg.data.transactionId).toEqual(transactionHash);
    expect(secondMsg.result.depositor).toEqual(depositor);
    expect(secondMsg.result.depository).toEqual(chain.depository);
    expect(secondMsg.result.currency).toEqual(token);
    expect(secondMsg.result.amount).toEqual(amount);
    expect(secondMsg.result.depositId).toEqual(id);
  });

  it("attestDepositoryDeposits - explicit deposit bundled with direct deposit", async () => {
    const chains = Object.values(await getChains());

    const chain = chains[randomNumber(chains.length)];
    const transactionHash = randomHex(32);

    const depositor = randomHex(20);
    const from = randomHex(20);
    const token = randomHex(20);
    const amount = randomNumber(1e10).toString();
    const id = randomHex(32);

    const params = {
      transactionHash,
      from,
      to: chain.depository!,
      token,
      amount,
    };

    const firstTransferLog = generateTransferLog({ ...params, logIndex: 1 });
    const depositLog = generateErc20DepositLog({
      ...params,
      id,
      from: depositor,
      logIndex: 4,
    });
    const secondTransferLog = generateTransferLog({ ...params, logIndex: 5 });
    const transactionReceipt = generateTransactionReceipt(transactionHash, [
      firstTransferLog,
      depositLog,
      secondTransferLog,
    ]);

    (httpRpc as jest.Mock).mockImplementation(() => ({
      getBlock: getBlockMock,
      getTransaction: async () => ({ input: "0x" }),
      getTransactionReceipt: async () => transactionReceipt,
    }));

    const { messages } =
      await new AttestationService().attestDepositoryDeposits({
        chainId: chain.id,
        transactionId: transactionHash,
      });
    expect(messages.length === 2).toBeTruthy();

    const firstMsg = messages[0];
    expect(firstMsg.data.chainId).toEqual(chain.id);
    expect(firstMsg.data.transactionId).toEqual(transactionHash);
    expect(firstMsg.result.depositor).toEqual(depositor);
    expect(firstMsg.result.depository).toEqual(chain.depository);
    expect(firstMsg.result.currency).toEqual(token);
    expect(firstMsg.result.amount).toEqual(amount);
    expect(firstMsg.result.depositId).toEqual(id);

    const secondMsg = messages[1];
    expect(secondMsg.data.chainId).toEqual(chain.id);
    expect(secondMsg.data.transactionId).toEqual(transactionHash);
    expect(secondMsg.result.depositor).toEqual(from);
    expect(secondMsg.result.depository).toEqual(chain.depository);
    expect(secondMsg.result.currency).toEqual(token);
    expect(secondMsg.result.amount).toEqual(amount);
    expect(secondMsg.result.depositId).toEqual(zeroHash);
  });

  it("attestDepositoryDeposits - Transfer event with non-matching RelayErc20Deposit event", async () => {
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
      to: chain.depository!,
      token,
      amount,
    };

    const transferLog = generateTransferLog({ ...params, logIndex: 0 });
    const depositLog = generateErc20DepositLog({
      ...params,
      id,
      amount: "1",
      logIndex: 3,
    });
    const transactionReceipt = generateTransactionReceipt(transactionHash, [
      transferLog,
      depositLog,
    ]);

    (httpRpc as jest.Mock).mockImplementation(() => ({
      getBlock: getBlockMock,
      getTransaction: async () => ({ input: "0x" }),
      getTransactionReceipt: async () => transactionReceipt,
    }));

    const { messages } =
      await new AttestationService().attestDepositoryDeposits({
        chainId: chain.id,
        transactionId: transactionHash,
      });
    expect(messages.length === 1).toBeTruthy();

    const msg = messages[0];

    expect(msg.data.chainId).toEqual(chain.id);
    expect(msg.data.transactionId).toEqual(transactionHash);
    expect(msg.result.depositor).toEqual(from);
    expect(msg.result.depository).toEqual(chain.depository);
    expect(msg.result.currency).toEqual(token);
    expect(msg.result.amount).toEqual(amount);
    expect(msg.result.depositId).toEqual(zeroHash);
  });

  it("attestDepositoryDeposits - Transfer event with consecutive RelayErc20Deposit event but without id", async () => {
    const chains = Object.values(await getChains());

    const chain = chains[randomNumber(chains.length)];
    const transactionHash = randomHex(32);

    const from = randomHex(20);
    const token = randomHex(20);
    const amount = randomNumber(1e10).toString();

    const params = {
      transactionHash,
      from,
      to: chain.depository!,
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
      getBlock: getBlockMock,
      getTransaction: async () => ({ input: "0x" }),
      getTransactionReceipt: async () => transactionReceipt,
    }));

    const { messages } =
      await new AttestationService().attestDepositoryDeposits({
        chainId: chain.id,
        transactionId: transactionHash,
      });
    expect(messages.length === 1).toBeTruthy();

    const msg = messages[0];

    expect(msg.data.chainId).toEqual(chain.id);
    expect(msg.data.transactionId).toEqual(transactionHash);
    expect(msg.result.depositor).toEqual(from);
    expect(msg.result.depository).toEqual(chain.depository);
    expect(msg.result.currency).toEqual(token);
    expect(msg.result.amount).toEqual(amount);
    expect(msg.result.depositId).toEqual(zeroHash);
  });

  it("attestDepositoryDeposits - Transfer event with consecutive RelayErc20Deposit and different depositor", async () => {
    const chains = Object.values(await getChains());

    const chain = chains[randomNumber(chains.length)];
    const transactionHash = randomHex(32);

    const from = randomHex(20);
    const depositor = randomHex(20);
    const token = randomHex(20);
    const amount = randomNumber(1e10).toString();
    const id = randomHex(32);

    const params = {
      transactionHash,
      from,
      to: chain.depository!,
      token,
      amount,
    };

    const transferLog = generateTransferLog({ ...params, logIndex: 0 });
    const depositLog = generateErc20DepositLog({
      ...params,
      from: depositor,
      id,
      logIndex: 1,
    });
    const transactionReceipt = generateTransactionReceipt(transactionHash, [
      transferLog,
      depositLog,
    ]);

    (httpRpc as jest.Mock).mockImplementation(() => ({
      getBlock: getBlockMock,
      getTransaction: async () => ({ input: "0x" }),
      getTransactionReceipt: async () => transactionReceipt,
    }));

    const { messages } =
      await new AttestationService().attestDepositoryDeposits({
        chainId: chain.id,
        transactionId: transactionHash,
      });
    expect(messages.length === 1).toBeTruthy();

    const msg = messages[0];

    expect(msg.data.chainId).toEqual(chain.id);
    expect(msg.data.transactionId).toEqual(transactionHash);
    expect(msg.result.depositor).toEqual(depositor);
    expect(msg.result.depository).toEqual(chain.depository);
    expect(msg.result.currency).toEqual(token);
    expect(msg.result.amount).toEqual(amount);
    expect(msg.result.depositId).toEqual(id);
  });

  it("attestDepositoryDeposits - Transfer event with consecutive RelayErc20Deposit and different depositor and without id", async () => {
    const chains = Object.values(await getChains());

    const chain = chains[randomNumber(chains.length)];
    const transactionHash = randomHex(32);

    const from = randomHex(20);
    const depositor = randomHex(20);
    const token = randomHex(20);
    const amount = randomNumber(1e10).toString();

    const params = {
      transactionHash,
      from,
      to: chain.depository!,
      token,
      amount,
    };

    const transferLog = generateTransferLog({ ...params, logIndex: 0 });
    const depositLog = generateErc20DepositLog({
      ...params,
      from: depositor,
      id: zeroHash,
      logIndex: 1,
    });
    const transactionReceipt = generateTransactionReceipt(transactionHash, [
      transferLog,
      depositLog,
    ]);

    (httpRpc as jest.Mock).mockImplementation(() => ({
      getBlock: getBlockMock,
      getTransaction: async () => ({ input: "0x" }),
      getTransactionReceipt: async () => transactionReceipt,
    }));

    const { messages } =
      await new AttestationService().attestDepositoryDeposits({
        chainId: chain.id,
        transactionId: transactionHash,
      });
    expect(messages.length === 1).toBeTruthy();

    const msg = messages[0];

    expect(msg.data.chainId).toEqual(chain.id);
    expect(msg.data.transactionId).toEqual(transactionHash);
    expect(msg.result.depositor).toEqual(depositor);
    expect(msg.result.depository).toEqual(chain.depository);
    expect(msg.result.currency).toEqual(token);
    expect(msg.result.amount).toEqual(amount);
    expect(msg.result.depositId).toEqual(zeroHash);
  });

  it("attestDepositoryDeposits - single RelayNativeDeposit event", async () => {
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
      to: chain.depository!,
      amount,
      id,
    });
    const transactionReceipt = generateTransactionReceipt(transactionHash, [
      depositLog,
    ]);

    (httpRpc as jest.Mock).mockImplementation(() => ({
      getBlock: getBlockMock,
      getTransaction: async () => ({ input: "0x" }),
      getTransactionReceipt: async () => transactionReceipt,
    }));

    const { messages } =
      await new AttestationService().attestDepositoryDeposits({
        chainId: chain.id,
        transactionId: transactionHash,
      });
    expect(messages.length === 1).toBeTruthy();

    const msg = messages[0];

    expect(msg.data.chainId).toEqual(chain.id);
    expect(msg.data.transactionId).toEqual(transactionHash);
    expect(msg.result.depositor).toEqual(from);
    expect(msg.result.depository).toEqual(chain.depository);
    expect(msg.result.currency).toEqual(zeroAddress);
    expect(msg.result.amount).toEqual(amount);
    expect(msg.result.depositId).toEqual(id);
  });

  it("attestDepositoryDeposits - single RelayNativeDeposit event without id", async () => {
    const chains = Object.values(await getChains());

    const chain = chains[randomNumber(chains.length)];
    const transactionHash = randomHex(32);

    const from = randomHex(20);
    const amount = randomNumber(1e10).toString();

    const depositLog = generateNativeDepositLog({
      transactionHash,
      logIndex: 0,
      from,
      to: chain.depository!,
      amount,
      id: zeroHash,
    });
    const transactionReceipt = generateTransactionReceipt(transactionHash, [
      depositLog,
    ]);

    (httpRpc as jest.Mock).mockImplementation(() => ({
      getBlock: getBlockMock,
      getTransaction: async () => ({ input: "0x" }),
      getTransactionReceipt: async () => transactionReceipt,
    }));

    const { messages } =
      await new AttestationService().attestDepositoryDeposits({
        chainId: chain.id,
        transactionId: transactionHash,
      });
    expect(messages.length === 1).toBeTruthy();

    const msg = messages[0];

    expect(msg.data.chainId).toEqual(chain.id);
    expect(msg.data.transactionId).toEqual(transactionHash);
    expect(msg.result.depositor).toEqual(from);
    expect(msg.result.depository).toEqual(chain.depository);
    expect(msg.result.currency).toEqual(zeroAddress);
    expect(msg.result.amount).toEqual(amount);
    expect(msg.result.depositId).toEqual(zeroHash);
  });

  it("attestDepositoryWithdrawal - successful attestation", async () => {
    const chains = Object.values(await getChains());

    const chain = chains[randomNumber(chains.length)];

    const withdrawalAddressRequest = createMockWithdrawalAddressRequest({
      chainId: chain.id,
    });

    const decodedWithdrawal: ReturnType<typeof decodeWithdrawal> = {
      vmType: "ethereum-vm",
      withdrawal: {
        calls: [
          {
            to: randomHex(20),
            data: randomHex(64),
            value: randomNumber(ONE_BILLION).toString(),
            allowFailure: false,
          },
        ],
        nonce: randomNumber(ONE_BILLION).toString(),
        expiration: randomNumber(ONE_BILLION),
      },
    };

    (getContract as jest.Mock).mockImplementation(() => ({
      read: {
        callRequests: () => true,
      },
    }));

    const { message } =
      await new AttestationService().attestDepositoryWithdrawal({
        chainId: chain.id,
        withdrawal: encodeWithdrawal(decodedWithdrawal),
        withdrawalAddressRequest,
      });
    expect(message.result.depository).toEqual(chain.depository);
    expect(message.result.status).toEqual(DepositoryWithdrawalStatus.EXECUTED);
  });

  it("attestDepositoryWithdrawal - expired attestation", async () => {
    const chains = Object.values(await getChains());

    const chain = chains[randomNumber(chains.length)];

    const withdrawalAddressRequest = createMockWithdrawalAddressRequest({
      chainId: chain.id,
    });

    const decodedWithdrawal: ReturnType<typeof decodeWithdrawal> = {
      vmType: "ethereum-vm",
      withdrawal: {
        calls: [
          {
            to: randomHex(20),
            data: randomHex(64),
            value: randomNumber(ONE_BILLION).toString(),
            allowFailure: false,
          },
        ],
        nonce: randomNumber(ONE_BILLION).toString(),
        expiration: randomNumber(ONE_BILLION),
      },
    };

    (getContract as jest.Mock).mockImplementation(() => ({
      read: {
        callRequests: () => false,
      },
    }));
    (httpRpc as jest.Mock).mockImplementation(() => ({
      getBlock: async () => ({
        number: BigInt(1e12),
        timestamp: BigInt(decodedWithdrawal.withdrawal.expiration + 1 + 60),
      }),
    }));

    const { message } =
      await new AttestationService().attestDepositoryWithdrawal({
        chainId: chain.id,
        withdrawal: encodeWithdrawal(decodedWithdrawal),
        withdrawalAddressRequest,
      });
    expect(message.result.depository).toEqual(chain.depository);
    expect(message.result.status).toEqual(DepositoryWithdrawalStatus.EXPIRED);
  });

  it("attestDepositoryWithdrawal - pending attestation", async () => {
    const chains = Object.values(await getChains());

    const chain = chains[randomNumber(chains.length)];

    const withdrawalAddressRequest = createMockWithdrawalAddressRequest({
      chainId: chain.id,
    });

    const decodedWithdrawal: ReturnType<typeof decodeWithdrawal> = {
      vmType: "ethereum-vm",
      withdrawal: {
        calls: [
          {
            to: randomHex(20),
            data: randomHex(64),
            value: randomNumber(ONE_BILLION).toString(),
            allowFailure: false,
          },
        ],
        nonce: randomNumber(ONE_BILLION).toString(),
        expiration: randomNumber(ONE_BILLION),
      },
    };

    (getContract as jest.Mock).mockImplementation(() => ({
      read: {
        callRequests: () => false,
      },
    }));
    (httpRpc as jest.Mock).mockImplementation(() => ({
      getBlock: async () => ({
        number: BigInt(1e12),
        timestamp: BigInt(decodedWithdrawal.withdrawal.expiration - 1),
      }),
    }));

    const { message } =
      await new AttestationService().attestDepositoryWithdrawal({
        chainId: chain.id,
        withdrawal: encodeWithdrawal(decodedWithdrawal),
        withdrawalAddressRequest,
      });
    expect(message.result.depository).toEqual(chain.depository);
    expect(message.result.status).toEqual(DepositoryWithdrawalStatus.PENDING);
  });

  it("attestSolverFill - validates solver fill correctly", async () => {
    await testAttestSolverFill({});
  });

  it("attestSolverFill - fails with invalid order signature", async () => {
    await testAttestSolverFill({
      invalidSignature: true,
      expectError: "Invalid order signature",
    });
  });

  it("attestSolverFill - fails with non-unique onchain ids", async () => {
    await testAttestSolverFill({
      duplicateOnchainIds: true,
      expectError: "Input information contains non-unique onchain ids",
    });
  });

  it("attestSolverFill - fails with insufficient fill amount", async () => {
    await testAttestSolverFill({
      insufficientPayment: true,
      expectError: "Insufficient fill amount for order output payment",
    });
  });

  it("attestSolverFill - fails with expired output deadline", async () => {
    await testAttestSolverFill({
      expiredDeadline: true,
      expectError: "deadline",
    });
  });

  it("attestSolverFill - validates with ERC20 token payments", async () => {
    await testAttestSolverFill({
      useErc20Token: true,
    });
  });

  it("attestSolverRefund - validates solver refund correctly", async () => {
    await testAttestSolverRefund({});
  });

  it("attestSolverRefund - fails with invalid order signature", async () => {
    await testAttestSolverRefund({
      invalidSignature: true,
      expectError: "Invalid order signature",
    });
  });

  it("attestSolverRefund - validates with ERC20 token payments", async () => {
    await testAttestSolverRefund({
      useErc20Token: true,
    });
  });

  it("verifySolverCalls - preserves SolverCallExecuted ordering", async () => {
    const chains = Object.values(await getChains());
    const chain = chains[randomNumber(chains.length)];
    const transactionHash = randomHex(32);
    const fillContract = randomHex(20);

    const firstCall = {
      to: randomHex(20),
      data: randomHex(32),
      value: randomNumber(ONE_BILLION).toString(),
      allowFailure: false,
    };
    const secondCall = {
      to: randomHex(20),
      data: randomHex(32),
      value: randomNumber(ONE_BILLION).toString(),
      allowFailure: false,
    };

    const receipt = generateTransactionReceipt(transactionHash, [
      generateSolverCallExecutedLog({
        transactionHash,
        logIndex: 1,
        fillContract,
        to: secondCall.to,
        data: secondCall.data,
        amount: secondCall.value,
      }),
      generateSolverCallExecutedLog({
        transactionHash,
        logIndex: 2,
        fillContract,
        to: firstCall.to,
        data: firstCall.data,
        amount: firstCall.value,
      }),
    ]);

    (httpRpc as jest.Mock).mockImplementation(() => ({
      getBlock: getBlockMock,
      getTransactionReceipt: async () => receipt,
    }));

    const result = await new EthereumVmAttestor().verifySolverCalls(
      chain.id,
      transactionHash,
      [
        encodeOrderCall({ vmType: "ethereum-vm", call: firstCall }),
        encodeOrderCall({ vmType: "ethereum-vm", call: secondCall }),
      ],
      encodeOrderExtraData({
        vmType: "ethereum-vm",
        extraData: { fillContract },
      })
    );

    expect(result).toBe(false);
  });
});

/**
 * Create ERC20 transfer transaction logs and receipt
 * @param params Parameters for creating ERC20 transfer transaction
 * @returns Transaction receipt with ERC20 transfer logs
 */
const createErc20TransferTransaction = ({
  transactionHash,
  from,
  to,
  tokenAddress,
  amount,
  depositId,
}: {
  transactionHash: string;
  from: string;
  to: string;
  tokenAddress: string;
  amount: string;
  depositId?: string;
}): TransactionReceipt => {
  const transferLog = generateTransferLog({
    transactionHash,
    logIndex: 0,
    from,
    to,
    token: tokenAddress,
    amount,
  });
  const depositLog = depositId
    ? generateErc20DepositLog({
        transactionHash,
        logIndex: 0,
        from,
        to,
        token: tokenAddress,
        amount,
        id: depositId,
      })
    : undefined;

  return generateTransactionReceipt(transactionHash, [
    transferLog,
    ...(depositLog ? [depositLog] : []),
  ]);
};

/**
 * Setup a unified test environment for both attestSolverFill and attestSolverRefund tests
 * @param options Configuration options for the test environment
 * @returns Test environment with all necessary data for testing
 */
const setupTestEnvironment = async (
  options: {
    useErc20Token?: boolean;
    invalidSignature?: boolean;
    expiredDeadline?: boolean;
    insufficientPayment?: boolean;
    duplicateOnchainIds?: boolean;
    customPaymentAmount?: string;
    actionType?: "fill" | "refund";
  } = {}
) => {
  const chains = Object.values(await getChains());
  const testData = setupTestData();
  testData.chain = chains[randomNumber(chains.length)];

  const depositTxHash = randomHex(32);
  const actionTxHash = randomHex(32); // Can be either fill or refund transaction hash

  // Adjust payment amount if specified
  const paymentAmount = options.customPaymentAmount || testData.paymentAmount;
  const fillAmount = options.insufficientPayment
    ? ((BigInt(paymentAmount) * 50n) / 100n).toString() // 50% of required amount
    : paymentAmount;

  // Create test order
  const testOrder = createTestOrder({
    paymentAmount,
    outputRecipient: testData.outputRecipient,
    refundRecipient: testData.refundRecipient,
    solverContractAddress: testData.solverContractAddress,
    solverAddress: solverWallet.address,
    inputCurrency: options.useErc20Token ? testData.tokenAddress : zeroAddress,
    outputCurrency: options.useErc20Token ? testData.tokenAddress : zeroAddress,
  });

  // Set expired deadline if specified
  if (options.expiredDeadline) {
    testOrder.output.deadline = Math.floor(Date.now() / 1000) - 3600;
  }

  const orderId = getOrderId(testOrder, await getSdkChainsConfig());

  // Create deposit transaction
  let depositTxReceipt: TransactionReceipt;
  if (options.useErc20Token) {
    depositTxReceipt = createErc20TransferTransaction({
      transactionHash: depositTxHash,
      from: testData.depositorAddress,
      to: testData.chain.depository,
      tokenAddress: testData.tokenAddress,
      amount: paymentAmount,
      depositId: orderId,
    });
  } else {
    depositTxReceipt = createNativeDepositTransaction({
      depositTxHash,
      depositorAddress: testData.depositorAddress,
      depositoryAddress: testData.chain.depository,
      paymentAmount,
      depositId: orderId,
    });
  }

  // Create action transaction receipt (fill or refund)
  let actionTxReceipt: TransactionReceipt;
  const isRefund = options.actionType === "refund";

  if (options.useErc20Token) {
    actionTxReceipt = createErc20TransferTransaction({
      transactionHash: actionTxHash,
      from: testData.solverContractAddress,
      to: isRefund ? testData.refundRecipient : testData.outputRecipient,
      tokenAddress: testData.tokenAddress,
      amount: fillAmount,
    });
  } else if (isRefund) {
    actionTxReceipt = createRefundTransaction({
      refundTxHash: actionTxHash,
      refundRecipient: testData.refundRecipient,
      solverContractAddress: testData.solverContractAddress,
      paymentAmount: fillAmount,
    });
  } else {
    actionTxReceipt = createFillTransaction({
      fillTxHash: actionTxHash,
      outputRecipient: testData.outputRecipient,
      solverContractAddress: testData.solverContractAddress,
      paymentAmount: fillAmount,
    });
  }

  // Setup RPC mock
  setupRpcMock({
    transactions: {
      [depositTxHash]: {
        input: "0x",
        receipt: depositTxReceipt,
      },
      [actionTxHash]: {
        input: orderId,
        receipt: actionTxReceipt,
      },
    },
  });

  // Create order signature
  const signerWallet = options.invalidSignature
    ? privateKeyToAccount(randomHex(32) as Hex) // Random wallet for invalid signature
    : solverWallet;

  const orderSignature = await signerWallet.signMessage({
    message: { raw: orderId },
  });

  // Get depository deposits
  const depositoryDeposits = await new AttestationService()
    .attestDepositoryDeposits({
      chainId: testData.chain.id,
      transactionId: depositTxHash,
    })
    .then((d) => d.messages);

  // Create inputs array
  const inputs = options.duplicateOnchainIds
    ? [
        {
          transactionId: depositTxHash,
          onchainId: depositoryDeposits[0].result.onchainId,
          inputIndex: 0,
        },
        {
          transactionId: depositTxHash,
          onchainId: depositoryDeposits[0].result.onchainId, // Duplicate onchainId
          inputIndex: 0,
        },
      ]
    : [
        {
          transactionId: depositTxHash,
          onchainId: depositoryDeposits[0].result.onchainId,
          inputIndex: 0,
        },
      ];

  return {
    testData,
    depositTxHash,
    actionTxHash,
    testOrder,
    orderSignature,
    depositoryDeposits,
    inputs,
    fillAmount,
    depositTxReceipt,
    actionTxReceipt,
  };
};

/**
 * Test attestSolverFill with various configurations
 * @param options Configuration options for the fill test
 * @returns Test result or error
 */
const testAttestSolverFill = async (options: {
  useErc20Token?: boolean;
  invalidSignature?: boolean;
  expiredDeadline?: boolean;
  insufficientPayment?: boolean;
  duplicateOnchainIds?: boolean;
  customPaymentAmount?: string;
  expectError?: string;
}) => {
  // Setup test environment with fill action type
  const env = await setupTestEnvironment({ ...options, actionType: "fill" });

  // Execute or expect error
  if (options.expectError) {
    await expect(
      new AttestationService().attestSolverFill({
        order: env.testOrder,
        orderSignature: env.orderSignature,
        inputs: env.inputs,
        fill: {
          transactionId: env.actionTxHash,
        },
      })
    ).rejects.toThrow(options.expectError);
    return null;
  } else {
    const solverFillResult = await new AttestationService().attestSolverFill({
      order: env.testOrder,
      orderSignature: env.orderSignature,
      inputs: env.inputs,
      fill: {
        transactionId: env.actionTxHash,
      },
    });

    expect(solverFillResult.message.result.status).toBe(
      SolverFillStatus.SUCCESSFUL
    );
    expect(
      solverFillResult.message.result.totalWeightedInputPaymentBpsDiff
    ).toBe("0");
    return solverFillResult;
  }
};

/**
 * Test attestSolverRefund with various configurations
 * @param options Configuration options for the refund test
 * @returns Test result or error
 */
const testAttestSolverRefund = async (options: {
  useErc20Token?: boolean;
  invalidSignature?: boolean;
  expiredDeadline?: boolean;
  insufficientPayment?: boolean;
  duplicateOnchainIds?: boolean;
  customPaymentAmount?: string;
  expectError?: string;
}) => {
  // Setup test environment with refund action type
  const env = await setupTestEnvironment({ ...options, actionType: "refund" });

  // Execute or expect error
  if (options.expectError) {
    await expect(
      new AttestationService().attestSolverRefund({
        order: env.testOrder,
        orderSignature: env.orderSignature,
        inputs: env.inputs,
        refunds: [
          {
            transactionId: env.actionTxHash,
            inputIndex: 0,
            refundIndex: 0,
          },
        ],
      })
    ).rejects.toThrow(options.expectError);
    return null;
  } else {
    const solverRefundResult =
      await new AttestationService().attestSolverRefund({
        order: env.testOrder,
        orderSignature: env.orderSignature,
        inputs: env.inputs,
        refunds: [
          {
            transactionId: env.actionTxHash,
            inputIndex: 0,
            refundIndex: 0,
          },
        ],
      });

    expect(solverRefundResult.message.result.status).toBe(
      SolverRefundStatus.SUCCESSFUL
    );
    expect(
      solverRefundResult.message.result.totalWeightedInputPaymentBpsDiff
    ).toBe("0");
    return solverRefundResult;
  }
};

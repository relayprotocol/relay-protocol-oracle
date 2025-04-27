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
    salt: "0x1",
    solver: {
      chainId: 1000,
      address: solverAddress,
    },
    inputs: [
      {
        payment: {
          chainId: 1000,
          currency: inputCurrency,
          amount: paymentAmount,
          weight: "1",
        },
        refunds: [
          {
            chainId: 1000,
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
      chainId: 1000,
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
function createDepositTransaction(params: {
  depositTxHash: string;
  depositorAddress: string;
  escrowAddress: string;
  tokenAddress: string;
  paymentAmount: string;
}) {
  const { depositTxHash, depositorAddress, escrowAddress, tokenAddress, paymentAmount } = params;
  
  const depositTransferLog = generateTransferLog({
    transactionHash: depositTxHash,
    logIndex: 0,
    from: depositorAddress,
    to: escrowAddress,
    token: tokenAddress,
    amount: paymentAmount,
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
  const { fillTxHash, outputRecipient, solverContractAddress, paymentAmount } = params;
  
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
  const { refundTxHash, refundRecipient, solverContractAddress, paymentAmount } = params;
  
  const refundNativeTransferLog = generateSolverNativeTransferLog({
    transactionHash: refundTxHash,
    logIndex: 0,
    from: refundRecipient,
    to: solverContractAddress,
    amount: paymentAmount,
  });
  
  return generateTransactionReceipt(refundTxHash, [refundNativeTransferLog]);
}

// Create mock RPC data
function createMockRpcData(params: {
  transactions: Record<string, { input: string; receipt: any }>;
  currentTimestamp: number;
}) {
  const { transactions, currentTimestamp } = params;
  
  return {
    transactions,
    block: {
      timestamp: BigInt(currentTimestamp),
      hash: randomHex(32),
      parentHash: randomHex(32),
    },
  };
}

// Setup RPC mock implementation
function setupRpcMock(mockRpcData: any) {
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
}

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
    const testData = setupTestData();
    testData.chain = chains[randomNumber(chains.length)];
    
    const depositTxHash = randomHex(32);
    const fillTxHash = randomHex(32);
    
    // Create deposit transaction
    const depositTxReceipt = createDepositTransaction({
      depositTxHash,
      depositorAddress: testData.depositorAddress,
      escrowAddress: testData.chain.escrow,
      tokenAddress: testData.tokenAddress,
      paymentAmount: testData.paymentAmount,
    });
    
    // Create fill transaction
    const fillTxReceipt = createFillTransaction({
      fillTxHash,
      outputRecipient: testData.outputRecipient,
      solverContractAddress: testData.solverContractAddress,
      paymentAmount: testData.paymentAmount,
    });
    
    // Create test order
    const vmType = "ethereum-vm";
    const testOrder = createTestOrder({
      paymentAmount: testData.paymentAmount,
      outputRecipient: testData.outputRecipient,
      refundRecipient: testData.refundRecipient,
      solverContractAddress: testData.solverContractAddress,
      solverAddress: solverWallet.address,
    });
    
    const orderHash = getOrderHash(testOrder, {
      1000: vmType,
    });
    
    // Create mock RPC data
    const mockRpcData = createMockRpcData({
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
      currentTimestamp: testData.currentTimestamp,
    });
    
    // Setup RPC mock
    setupRpcMock(mockRpcData);
    
    const orderSignature = await solverWallet.signMessage({
      message: { raw: orderHash },
    });
    
    const escrowDeposits = await new AttestationService().attestEscrowDeposits({
      chainId: testData.chain.id,
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

  it("attestSolverFill - fails with invalid order signature", async () => {
    const chains = Object.values(await getChains());
    const testData = setupTestData();
    testData.chain = chains[randomNumber(chains.length)];
    
    const depositTxHash = randomHex(32);
    const fillTxHash = randomHex(32);
    
    // Create deposit transaction
    const depositTxReceipt = createDepositTransaction({
      depositTxHash,
      depositorAddress: testData.depositorAddress,
      escrowAddress: testData.chain.escrow,
      tokenAddress: testData.tokenAddress,
      paymentAmount: testData.paymentAmount,
    });
    
    // Create fill transaction
    const fillTxReceipt = createFillTransaction({
      fillTxHash,
      outputRecipient: testData.outputRecipient,
      solverContractAddress: testData.solverContractAddress,
      paymentAmount: testData.paymentAmount,
    });
    
    // Create test order
    const vmType = "ethereum-vm";
    const testOrder = createTestOrder({
      paymentAmount: testData.paymentAmount,
      outputRecipient: testData.outputRecipient,
      refundRecipient: testData.refundRecipient,
      solverContractAddress: testData.solverContractAddress,
      solverAddress: solverWallet.address,
    });
    
    const orderHash = getOrderHash(testOrder, {
      1000: vmType,
    });
    
    // Create mock RPC data
    const mockRpcData = createMockRpcData({
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
      currentTimestamp: testData.currentTimestamp,
    });
    
    // Setup RPC mock
    setupRpcMock(mockRpcData);
    
    // Create an invalid signature (using a different wallet)
    const invalidWallet = privateKeyToAccount(randomHex(32) as Hex);
    const invalidOrderSignature = await invalidWallet.signMessage({
      message: { raw: orderHash },
    });
    
    const escrowDeposits = await new AttestationService().attestEscrowDeposits({
      chainId: testData.chain.id,
      transactionId: depositTxHash,
    });
    
    // Expect the function to throw an error with invalid signature
    await expect(
      new AttestationService().attestSolverFill({
        order: testOrder,
        orderSignature: invalidOrderSignature,
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
      })
    ).rejects.toThrow("Invalid order signature");
  });

  it("attestSolverFill - fails with non-unique onchain ids", async () => {
    const chains = Object.values(await getChains());
    const testData = setupTestData();
    testData.chain = chains[randomNumber(chains.length)];
    
    const depositTxHash = randomHex(32);
    const fillTxHash = randomHex(32);
    
    // Create deposit transaction
    const depositTxReceipt = createDepositTransaction({
      depositTxHash,
      depositorAddress: testData.depositorAddress,
      escrowAddress: testData.chain.escrow,
      tokenAddress: testData.tokenAddress,
      paymentAmount: testData.paymentAmount,
    });
    
    // Create fill transaction
    const fillTxReceipt = createFillTransaction({
      fillTxHash,
      outputRecipient: testData.outputRecipient,
      solverContractAddress: testData.solverContractAddress,
      paymentAmount: testData.paymentAmount,
    });
    
    // Create test order
    const vmType = "ethereum-vm";
    const testOrder = createTestOrder({
      paymentAmount: testData.paymentAmount,
      outputRecipient: testData.outputRecipient,
      refundRecipient: testData.refundRecipient,
      solverContractAddress: testData.solverContractAddress,
      solverAddress: solverWallet.address,
    });
    
    const orderHash = getOrderHash(testOrder, {
      1000: vmType,
    });
    
    // Create mock RPC data
    const mockRpcData = createMockRpcData({
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
      currentTimestamp: testData.currentTimestamp,
    });
    
    // Setup RPC mock
    setupRpcMock(mockRpcData);
    
    const orderSignature = await solverWallet.signMessage({
      message: { raw: orderHash },
    });
    
    const escrowDeposits = await new AttestationService().attestEscrowDeposits({
      chainId: testData.chain.id,
      transactionId: depositTxHash,
    });
    
    // Expect the function to throw an error with duplicate onchain ids
    await expect(
      new AttestationService().attestSolverFill({
        order: testOrder,
        orderSignature: orderSignature,
        inputs: [
          {
            transactionId: depositTxHash,
            onchainId: escrowDeposits[0].onchainId,
            inputIndex: 0,
          },
          {
            transactionId: depositTxHash,
            onchainId: escrowDeposits[0].onchainId, // Same onchainId as above
            inputIndex: 0,
          },
        ],
        fill: {
          transactionId: fillTxHash,
        },
      })
    ).rejects.toThrow("Input information contains non-unique onchain ids");
  });

  it("attestSolverFill - fails with insufficient fill amount", async () => {
    const chains = Object.values(await getChains());
    const testData = setupTestData();
    testData.chain = chains[randomNumber(chains.length)];
    
    const depositTxHash = randomHex(32);
    const fillTxHash = randomHex(32);
    
    // Create deposit transaction
    const depositTxReceipt = createDepositTransaction({
      depositTxHash,
      depositorAddress: testData.depositorAddress,
      escrowAddress: testData.chain.escrow,
      tokenAddress: testData.tokenAddress,
      paymentAmount: testData.paymentAmount,
    });
    
    // Create fill transaction with insufficient amount (50% of required)
    const insufficientAmount = (BigInt(testData.paymentAmount) * 50n / 100n).toString();
    const fillTxReceipt = createFillTransaction({
      fillTxHash,
      outputRecipient: testData.outputRecipient,
      solverContractAddress: testData.solverContractAddress,
      paymentAmount: insufficientAmount,
    });
    
    // Create test order
    const vmType = "ethereum-vm";
    const testOrder = createTestOrder({
      paymentAmount: testData.paymentAmount,
      outputRecipient: testData.outputRecipient,
      refundRecipient: testData.refundRecipient,
      solverContractAddress: testData.solverContractAddress,
      solverAddress: solverWallet.address,
    });
    
    const orderHash = getOrderHash(testOrder, {
      1000: vmType,
    });
    
    // Create mock RPC data
    const mockRpcData = createMockRpcData({
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
      currentTimestamp: testData.currentTimestamp,
    });
    
    // Setup RPC mock
    setupRpcMock(mockRpcData);
    
    const orderSignature = await solverWallet.signMessage({
      message: { raw: orderHash },
    });
    
    const escrowDeposits = await new AttestationService().attestEscrowDeposits({
      chainId: testData.chain.id,
      transactionId: depositTxHash,
    });
    
    // Expect the function to throw an error with insufficient fill amount
    await expect(
      new AttestationService().attestSolverFill({
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
      })
    ).rejects.toThrow("Insufficient fill amount for order output payment");
  });

  it("attestSolverFill - fails with expired output deadline", async () => {
    const chains = Object.values(await getChains());
    const testData = setupTestData();
    testData.chain = chains[randomNumber(chains.length)];
    
    const depositTxHash = randomHex(32);
    const fillTxHash = randomHex(32);
    
    // Create deposit transaction
    const depositTxReceipt = createDepositTransaction({
      depositTxHash,
      depositorAddress: testData.depositorAddress,
      escrowAddress: testData.chain.escrow,
      tokenAddress: testData.tokenAddress,
      paymentAmount: testData.paymentAmount,
    });
    
    // Create fill transaction
    const fillTxReceipt = createFillTransaction({
      fillTxHash,
      outputRecipient: testData.outputRecipient,
      solverContractAddress: testData.solverContractAddress,
      paymentAmount: testData.paymentAmount,
    });
    
    // Create test order with expired deadline (1 hour in the past)
    const vmType = "ethereum-vm";
    const testOrder = createTestOrder({
      paymentAmount: testData.paymentAmount,
      outputRecipient: testData.outputRecipient,
      refundRecipient: testData.refundRecipient,
      solverContractAddress: testData.solverContractAddress,
      solverAddress: solverWallet.address,
    });
    
    // Set an expired deadline (1 hour in the past)
    testOrder.output.deadline = Math.floor(Date.now() / 1000) - 3600;
    
    const orderHash = getOrderHash(testOrder, {
      1000: vmType,
    });
    
    // Create mock RPC data with a current timestamp that's after the deadline
    const mockRpcData = createMockRpcData({
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
      currentTimestamp: Math.floor(Date.now() / 1000),
    });
    
    // Setup RPC mock
    setupRpcMock(mockRpcData);
    
    const orderSignature = await solverWallet.signMessage({
      message: { raw: orderHash },
    });
    
    const escrowDeposits = await new AttestationService().attestEscrowDeposits({
      chainId: testData.chain.id,
      transactionId: depositTxHash,
    });
    
    // Expect the function to throw an error with expired deadline
    await expect(
      new AttestationService().attestSolverFill({
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
      })
    ).rejects.toThrow("deadline");
  });

  it("attestSolverFill - validates with ERC20 token payments", async () => {
    const chains = Object.values(await getChains());
    const testData = setupTestData();
    testData.chain = chains[randomNumber(chains.length)];
    
    const depositTxHash = randomHex(32);
    const fillTxHash = randomHex(32);
    
    // Create deposit transaction with ERC20 token
    const depositTransferLog = generateTransferLog({
      transactionHash: depositTxHash,
      logIndex: 0,
      from: testData.depositorAddress,
      to: testData.chain.escrow,
      token: testData.tokenAddress,
      amount: testData.paymentAmount,
    });
    
    const depositTxReceipt = generateTransactionReceipt(depositTxHash, [
      depositTransferLog,
    ]);
    
    // Create fill transaction with ERC20 token
    const fillTransferLog = generateTransferLog({
      transactionHash: fillTxHash,
      logIndex: 0,
      from: testData.solverContractAddress,
      to: testData.outputRecipient,
      token: testData.tokenAddress,
      amount: testData.paymentAmount,
    });
    
    const fillTxReceipt = generateTransactionReceipt(fillTxHash, [
      fillTransferLog,
    ]);
    
    // Create test order with ERC20 token
    const vmType = "ethereum-vm";
    const testOrder = createTestOrder({
      paymentAmount: testData.paymentAmount,
      outputRecipient: testData.outputRecipient,
      refundRecipient: testData.refundRecipient,
      solverContractAddress: testData.solverContractAddress,
      solverAddress: solverWallet.address,
      inputCurrency: testData.tokenAddress,
      outputCurrency: testData.tokenAddress,
    });
    
    const orderHash = getOrderHash(testOrder, {
      1000: vmType,
    });
    
    // Create mock RPC data
    const mockRpcData = createMockRpcData({
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
      currentTimestamp: testData.currentTimestamp,
    });
    
    // Setup RPC mock
    setupRpcMock(mockRpcData);
    
    const orderSignature = await solverWallet.signMessage({
      message: { raw: orderHash },
    });
    
    const escrowDeposits = await new AttestationService().attestEscrowDeposits({
      chainId: testData.chain.id,
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
    const testData = setupTestData();
    testData.chain = chains[randomNumber(chains.length)];
    
    const depositTxHash = randomHex(32);
    const refundTxHash = randomHex(32);
    
    // Create deposit transaction
    const depositTxReceipt = createDepositTransaction({
      depositTxHash,
      depositorAddress: testData.depositorAddress,
      escrowAddress: testData.chain.escrow,
      tokenAddress: testData.tokenAddress,
      paymentAmount: testData.paymentAmount,
    });
    
    // Create refund transaction
    const refundTxReceipt = createRefundTransaction({
      refundTxHash,
      refundRecipient: testData.refundRecipient,
      solverContractAddress: testData.solverContractAddress,
      paymentAmount: testData.paymentAmount,
    });
    
    // Create test order
    const vmType = "ethereum-vm";
    const testOrder = createTestOrder({
      paymentAmount: testData.paymentAmount,
      outputRecipient: testData.outputRecipient,
      refundRecipient: testData.refundRecipient,
      solverContractAddress: testData.solverContractAddress,
      solverAddress: solverWallet.address,
    });
    
    const orderHash = getOrderHash(testOrder, {
      1000: vmType,
    });
    
    // Create mock RPC data
    const mockRpcData = createMockRpcData({
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
      currentTimestamp: testData.currentTimestamp,
    });
    
    // Setup RPC mock
    setupRpcMock(mockRpcData);
    
    const orderSignature = await solverWallet.signMessage({
      message: { raw: orderHash },
    });
    
    const escrowDeposits = await new AttestationService().attestEscrowDeposits({
      chainId: testData.chain.id,
      transactionId: depositTxHash,
    });
    
    const solverRefundResult = await new AttestationService().attestSolverRefund({
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
    expect(solverRefundResult.result.totalWeightedInputPaymentBpsDiff).toBe("0");
  });
});

import { describe, expect, it, jest } from "@jest/globals";

import { randomBase58 } from "../../../common/utils";
import { Chain, getChains } from "../../../../src/common/chains";
import { httpRpc } from "../../../../src/common/vm/solana-vm/rpc";
import { AttestationService } from "../../../../src/services/attestation";
import { privateKeyToAccount } from "viem/accounts";
import {
  getOrderId,
  Order,
  SolverRefundStatus,
} from "@reservoir0x/relay-protocol-sdk";
import { Hex } from "viem";
import { randomHex, randomNumber } from "../../../common/utils";
import {
  PublicKey,
  TransactionResponse as SolanaTransactionResponse,
} from "@solana/web3.js";
import bs58 from "bs58";
import * as anchor from "@coral-xyz/anchor";
import { BorshInstructionCoder, Idl } from "@coral-xyz/anchor";
import { RelayDepositoryIdl } from "../../../../src/services/attestation/vm/solana-vm/idls/RelayDepositoryIdl";

type TransactionResponse = SolanaTransactionResponse;

const zeroAddress = "11111111111111111111111111111111";
const testSolverPrivateKey =
  "0x1234567890123456789012345678901234567890123456789012345678901234";
const solverWallet = privateKeyToAccount(testSolverPrivateKey);

// Create instruction coder for generating valid instruction data
const instructionCoder = new BorshInstructionCoder(RelayDepositoryIdl as Idl);

// Helper function to generate instruction data for deposits
function generateDepositInstructionData(
  orderHash: string,
  amount: string,
  isToken: boolean = false
) {
  // Convert orderHash to id array (remove 0x prefix and convert to Buffer, then to array)
  const idBuffer = Buffer.from(orderHash.slice(2), "hex");
  const id = Array.from(idBuffer);

  const instructionName = isToken ? "deposit_token" : "deposit_native";
  const instructionData = {
    amount: new anchor.BN(amount),
    id: id,
  };

  return bs58.encode(instructionCoder.encode(instructionName, instructionData));
}

const generateTransactionResponse = (
  transactionHash: string,
  logs: string[],
  instructions?: any[],
  accountKeys?: any[],
  options?: {
    paymentRecipient?: string;
    paymentAmount?: string;
    tokenMint?: string;
    preTokenBalances?: any[];
    postTokenBalances?: any[];
  }
): TransactionResponse => {
  // Default transaction keys - include SystemProgram by default
  const defaultKeys = [
    new PublicKey(options?.paymentRecipient || randomBase58(32)),
    new PublicKey(zeroAddress), // System program
  ];

  const keys = accountKeys || defaultKeys;

  // Generate random blockTime in the past hour
  const blockTime = Math.floor(Date.now() / 1000) - randomNumber(3600);

  // Initialize balance arrays with zeros for all accounts
  const preBalances = Array(keys.length).fill(0);
  const postBalances = Array(keys.length).fill(0);

  // If a payment is simulated, set appropriate balance changes
  if (options?.paymentAmount && options?.paymentRecipient) {
    // Find recipient index in account keys
    const recipientIndex = keys.findIndex(
      (key) => key.toBase58() === options.paymentRecipient
    );

    if (recipientIndex !== -1) {
      const paymentAmountLamports = BigInt(options.paymentAmount);
      const initialBalance = BigInt(randomNumber(1e9));

      // Set pre and post balances for the recipient
      preBalances[recipientIndex] = initialBalance;
      postBalances[recipientIndex] = initialBalance + paymentAmountLamports;
    }
  }

  // Build token balance arrays if needed
  let preTokenBalances: any[] = [];
  let postTokenBalances: any[] = [];

  if (
    options?.tokenMint &&
    options?.paymentRecipient &&
    options?.paymentAmount
  ) {
    const initialTokenAmount = randomNumber(1e9).toString();
    const finalTokenAmount = (
      BigInt(initialTokenAmount) + BigInt(options.paymentAmount)
    ).toString();

    preTokenBalances = [
      {
        accountIndex: 0,
        mint: options.tokenMint,
        owner: options.paymentRecipient,
        uiTokenAmount: {
          amount: initialTokenAmount,
          decimals: 9,
          uiAmount: null,
          uiAmountString: initialTokenAmount,
        },
      },
    ];

    postTokenBalances = [
      {
        accountIndex: 0,
        mint: options.tokenMint,
        owner: options.paymentRecipient,
        uiTokenAmount: {
          amount: finalTokenAmount,
          decimals: 9,
          uiAmount: null,
          uiAmountString: finalTokenAmount,
        },
      },
    ];
  } else if (options?.preTokenBalances && options?.postTokenBalances) {
    preTokenBalances = options.preTokenBalances;
    postTokenBalances = options.postTokenBalances;
  }

  return {
    slot: randomNumber(1e10),
    blockTime,
    meta: {
      err: null,
      fee: randomNumber(1e6),
      preBalances,
      postBalances,
      innerInstructions: [],
      logMessages: logs,
      preTokenBalances,
      postTokenBalances,
      loadedAddresses: {
        readonly: [],
        writable: [],
      },
    },
    transaction: {
      signatures: [transactionHash],
      message: {
        compiledInstructions: instructions ?? [],
        accountKeys: accountKeys ?? [],
        recentBlockhash: randomBase58(10),
        instructions: [],
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 0,
        },
        getAccountKeys: () => ({
          staticAccountKeys: keys,
        }),
      } as any,
    },
  };
};

const createSPLTransferTransaction = ({
  transactionHash,
  from,
  to,
  tokenAddress,
  amount,
  orderHash,
}: {
  transactionHash: string;
  from: string;
  to: string;
  tokenAddress: string;
  amount: string;
  orderHash: string;
}): TransactionResponse => {
  // Generate instruction data with correct orderHash for SPL token deposit
  const depositInstructionData = generateDepositInstructionData(
    orderHash,
    amount,
    true
  );

  // Create a mock transaction that mimics the working test case for SPL tokens
  const mockTransaction = {
    slot: Math.floor(Date.now() / 1000),
    blockTime: Math.floor(Date.now() / 1000),
    meta: {
      err: null,
      fee: 5000,
      preBalances: [0, 0, 0, 0, 0, 0],
      postBalances: [0, 0, 0, 0, 0, 0],
      innerInstructions: [
        {
          index: 0,
          instructions: [
            {
              // deposit_token instruction with dynamic data
              programIdIndex: 0,
              accounts: [0, 1, 2, 3, 4],
              data: depositInstructionData,
            },
            {
              // memo instruction containing order hash
              programIdIndex: 5, // Memo program index
              accounts: [],
              data: bs58.encode(Buffer.from(orderHash, "utf-8")),
            },
          ],
        },
      ],
      logMessages: [
        `Program log: SPL Transfer executed for order: ${orderHash}`,
      ],
      preTokenBalances: [
        {
          accountIndex: 1,
          mint: tokenAddress,
          owner: to,
          uiTokenAmount: {
            amount: "0",
            decimals: 9,
            uiAmount: 0,
            uiAmountString: "0",
          },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          owner: to,
          mint: tokenAddress,
          uiTokenAmount: {
            amount: amount,
            decimals: 9,
            uiAmount: parseFloat(amount) / 1e9,
            uiAmountString: (parseFloat(amount) / 1e9).toString(),
          },
        },
      ],
      loadedAddresses: {
        writable: [],
        readonly: [],
      },
    },
    transaction: {
      signatures: [transactionHash],
      message: {
        accountKeys: [
          { pubkey: to, signer: false }, // Depository/recipient
          {
            pubkey: "7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ",
            signer: false,
          },
          { pubkey: from, signer: true }, // Depositor
          { pubkey: "11111111111111111111111111111111", signer: false },
          { pubkey: tokenAddress, signer: false }, // Token mint
          {
            pubkey: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
            signer: false,
          }, // Memo program
        ],
        instructions: [],
        getAccountKeys: () => ({
          staticAccountKeys: [
            { toBase58: () => to },
            { toBase58: () => "7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ" },
            { toBase58: () => from },
            { toBase58: () => "11111111111111111111111111111111" },
            { toBase58: () => tokenAddress },
            { toBase58: () => "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" },
          ],
        }),
        compiledInstructions: [],
        addressTableLookups: [],
      },
    },
  };

  return mockTransaction as any;
};

// Create deposit transaction logs
function createDepositTransaction(params: {
  depositTxHash: string;
  depositorAddress: string;
  depositoryAddress: string;
  tokenAddress: string;
  paymentAmount: string;
  orderHash: string;
}): TransactionResponse {
  const {
    depositTxHash,
    depositorAddress,
    depositoryAddress,
    paymentAmount,
    orderHash,
  } = params;

  // Generate instruction data with correct orderHash
  const instructionData = generateDepositInstructionData(
    orderHash,
    paymentAmount,
    false
  );

  // Create a mock transaction that mimics the working test case
  const mockTransaction = {
    slot: Math.floor(Date.now() / 1000),
    blockTime: Math.floor(Date.now() / 1000),
    meta: {
      err: null,
      fee: 5000,
      preBalances: [0, 0, 0, 0, 0],
      postBalances: [0, 0, 0, 0, 0],
      innerInstructions: [
        {
          index: 0,
          instructions: [
            {
              // deposit_native instruction with dynamic data
              programIdIndex: 0,
              accounts: [0, 1, 2, 3, 4],
              data: instructionData,
            },
          ],
        },
      ],
      logMessages: [],
      preTokenBalances: [],
      postTokenBalances: [],
      loadedAddresses: {
        writable: [],
        readonly: [],
      },
    },
    transaction: {
      signatures: [depositTxHash],
      message: {
        accountKeys: [
          { pubkey: depositoryAddress, signer: false },
          {
            pubkey: "7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ",
            signer: false,
          },
          { pubkey: depositorAddress, signer: true },
          { pubkey: "11111111111111111111111111111111", signer: false },
          {
            pubkey: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
            signer: false,
          },
        ],
        instructions: [],
        getAccountKeys: () => ({
          staticAccountKeys: [
            { toBase58: () => depositoryAddress },
            { toBase58: () => "7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ" },
            { toBase58: () => depositorAddress },
            { toBase58: () => "11111111111111111111111111111111" },
            { toBase58: () => "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" },
          ],
        }),
        compiledInstructions: [],
        addressTableLookups: [],
      },
    },
  };

  return mockTransaction as any;
}

// Create refund transaction logs
function createRefundTransaction(params: {
  refundTxHash: string;
  refundRecipient: string;
  solverContractAddress: string;
  paymentAmount: string;
  orderHash: string;
}): TransactionResponse {
  const {
    refundTxHash,
    refundRecipient,
    solverContractAddress,
    paymentAmount,
    orderHash,
  } = params;

  // Create memo instruction containing order hash
  const memoInstruction = {
    programIdIndex: 0, // Index of the memo program in the accountKeys array
    accountKeyIndexes: [],
    data: Buffer.from(orderHash, "utf-8"),
  };

  // Create account keys including memo program and recipient
  const accountKeys = [
    new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), // Memo program
    new PublicKey(refundRecipient), // Refund recipient
    new PublicKey(solverContractAddress), // Solver contract
    new PublicKey(zeroAddress), // System program (for native SOL transfers)
  ];

  // Generate transaction with balance changes showing payment to the recipient
  return generateTransactionResponse(
    refundTxHash,
    [`Program log: Refund executed for order: ${orderHash}`],
    [memoInstruction],
    accountKeys,
    {
      paymentRecipient: refundRecipient,
      paymentAmount: paymentAmount,
    }
  );
}

// Create fill transaction logs
function createFillTransaction(params: {
  fillTxHash: string;
  outputRecipient: string;
  solverContractAddress: string;
  paymentAmount: string;
  orderHash: string;
}): TransactionResponse {
  const {
    fillTxHash,
    outputRecipient,
    solverContractAddress,
    paymentAmount,
    orderHash,
  } = params;

  // Create memo instruction containing order hash
  const memoInstruction = {
    programIdIndex: 0, // Index of the memo program in the accountKeys array
    accountKeyIndexes: [],
    data: Buffer.from(orderHash, "utf-8"),
  };

  // Create account keys including memo program and recipient
  const accountKeys = [
    new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), // Memo program
    new PublicKey(outputRecipient), // Payment recipient
    new PublicKey(solverContractAddress), // Solver contract
    new PublicKey(zeroAddress), // System program (for native SOL transfers)
  ];

  // Generate transaction with balance changes showing payment to the recipient
  return generateTransactionResponse(
    fillTxHash,
    [`Program log: Fill executed for order: ${orderHash}`],
    [memoInstruction],
    accountKeys,
    {
      paymentRecipient: outputRecipient,
      paymentAmount: paymentAmount,
    }
  );
}

// Create a standard test Order object
function createTestOrder({
  paymentAmount,
  outputRecipient,
  refundRecipient,
  solverAddress,
  inputCurrency = zeroAddress,
  outputCurrency = zeroAddress,
}: {
  paymentAmount: string;
  outputRecipient: string;
  refundRecipient: string;
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
          chainId: "solana",
          currency: inputCurrency,
          amount: paymentAmount,
          weight: "1",
        },
        refunds: [
          {
            chainId: "solana",
            recipient: refundRecipient,
            currency: inputCurrency,
            minimumAmount: paymentAmount,
            deadline: Math.floor(Date.now() / 1000) + 36000,
            extraData: "0x",
          },
        ],
      },
    ],
    output: {
      chainId: "solana",
      payments: [
        {
          recipient: outputRecipient,
          currency: outputCurrency,
          minimumAmount: paymentAmount,
          expectedAmount: paymentAmount,
        },
      ],
      calls: [],
      extraData: "0x",
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
  const depositorAddress = randomBase58(32);
  const tokenAddress = randomBase58(32);
  const paymentAmount = randomNumber(1e10).toString();
  const outputRecipient = randomBase58(32);
  const refundRecipient = randomBase58(32);
  const solverContractAddress = randomBase58(32);

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

/**
 * Setup a unified test environment for both attestSolverFill and attestSolverRefund tests
 * @param options Configuration options for the test environment
 * @returns Test environment with all necessary data for testing
 */
const setupTestEnvironment = async (
  options: {
    useSPLToken?: boolean;
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
  testData.chain = chains.find((chain) => chain.id === "solana");

  const depositTxHash = randomBase58(32);
  const actionTxHash = randomBase58(32); // Can be either fill or refund transaction hash

  // Adjust payment amount if specified
  const paymentAmount = options.customPaymentAmount || testData.paymentAmount;
  const fillAmount = options.insufficientPayment
    ? ((BigInt(paymentAmount) * 50n) / 100n).toString() // 50% of required amount
    : paymentAmount;

  // Create test order first to generate orderHash
  const testOrder = createTestOrder({
    paymentAmount,
    outputRecipient: testData.outputRecipient,
    refundRecipient: testData.refundRecipient,
    solverAddress: solverWallet.address,
    inputCurrency: options.useSPLToken ? testData.tokenAddress : zeroAddress,
    outputCurrency: options.useSPLToken ? testData.tokenAddress : zeroAddress,
  });

  // Set expired deadline if specified
  if (options.expiredDeadline) {
    testOrder.output.deadline = Math.floor(Date.now() / 1000) - 3600; // 1 hour in the past
  }

  const orderHash = getOrderId(testOrder, {
    solana: "solana-vm",
    ethereum: "ethereum-vm",
  });

  // Create deposit transaction with the generated orderHash
  let depositTxReceipt: TransactionResponse;
  if (options.useSPLToken) {
    depositTxReceipt = createSPLTransferTransaction({
      transactionHash: depositTxHash,
      from: testData.depositorAddress,
      to: testData.chain.depository,
      tokenAddress: testData.tokenAddress,
      amount: paymentAmount,
      orderHash,
    });
  } else {
    depositTxReceipt = createDepositTransaction({
      depositTxHash,
      depositorAddress: testData.depositorAddress,
      depositoryAddress: testData.chain.depository,
      tokenAddress: testData.tokenAddress,
      paymentAmount,
      orderHash,
    });
  }

  // Create action transaction receipt (fill or refund)
  let actionTxReceipt: TransactionResponse;
  const isRefund = options.actionType === "refund";

  if (options.useSPLToken) {
    actionTxReceipt = createSPLTransferTransaction({
      transactionHash: actionTxHash,
      from: testData.solverContractAddress,
      to: isRefund ? testData.refundRecipient : testData.outputRecipient,
      tokenAddress: testData.tokenAddress,
      amount: fillAmount,
      orderHash,
    });
  } else if (isRefund) {
    actionTxReceipt = createRefundTransaction({
      refundTxHash: actionTxHash,
      refundRecipient: testData.refundRecipient,
      solverContractAddress: testData.solverContractAddress,
      paymentAmount: fillAmount,
      orderHash,
    });
  } else {
    actionTxReceipt = createFillTransaction({
      fillTxHash: actionTxHash,
      outputRecipient: testData.outputRecipient,
      solverContractAddress: testData.solverContractAddress,
      paymentAmount: fillAmount,
      orderHash,
    });
  }

  // Create mock RPC data
  const mockRpcData = createMockRpcData({
    transactions: {
      [depositTxHash]: {
        input: "0x",
        receipt: depositTxReceipt,
      },
      [actionTxHash]: {
        input: orderHash,
        receipt: actionTxReceipt,
      },
    },
    currentTimestamp: options.expiredDeadline
      ? Math.floor(Date.now() / 1000)
      : testData.currentTimestamp,
  });

  // Setup RPC mock
  setupRpcMock(mockRpcData);

  // Create order signature
  const signerWallet = options.invalidSignature
    ? privateKeyToAccount(randomHex(32) as Hex) // Random wallet for invalid signature
    : solverWallet;

  const orderSignature = await signerWallet.signMessage({
    message: { raw: orderHash },
  });

  // Get depository deposits using the real method
  const depositoryDeposits =
    await new AttestationService().attestDepositoryDeposits({
      chainId: testData.chain.id,
      transactionId: depositTxHash,
    });

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
    getParsedTransaction: (txId: string) => {
      const receipt = mockRpcData.transactions[txId]?.receipt;
      return receipt;
    },
    getTransaction: (txId: any) => {
      const txData = mockRpcData.transactions[txId]?.receipt;
      if (!txData) {
        throw new Error(`Invalid transaction ID: ${txId}`);
      }
      return txData;
    },
  }));
}

/**
 * Test attestSolverFill with various configurations
 * @param options Configuration options for the fill test
 * @returns Test result or error
 */
const testAttestSolverFill = async (options: {
  useSPLToken?: boolean;
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
      SolverRefundStatus.SUCCESSFUL
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
  useSPLToken?: boolean;
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

jest.mock("../../../../src/common/chains", () => {
  const chains: Record<string, Chain> = {
    solana: {
      id: "solana",
      vmType: "solana-vm",
      httpRpcUrl: "http://127.0.0.1:8545",
      depository: "FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u",
    },
    ethereum: {
      id: "ethereum",
      vmType: "ethereum-vm",
      httpRpcUrl: "http://127.0.0.1:8546",
      depository: "0x2e988a386a799f506693793c6a5af6b54dfaabfb",
    },
  };
  return {
    getChains: async () => chains,
    getChain: async (chainId: string) => chains[chainId],
    getSdkChainsConfig: () =>
      Object.fromEntries(
        Object.values(chains).map((chain) => [chain.id, chain.vmType])
      ),
  };
});
jest.mock("../../../../src/common/vm/solana-vm/rpc", () => {
  return {
    httpRpc: jest.fn(),
  };
});

describe("SolanaVmAttestor", () => {
  it("attestDepositoryDeposits - should attest spl-token deposit instruction", async () => {
    // Mock a transaction containing deposit_token instruction but with truncated logs
    const mockTransaction = {
      meta: {
        // Empty log messages to force instruction parsing
        logMessages: [],
        innerInstructions: [
          {
            index: 0,
            instructions: [
              {
                // deposit_token instruction
                programIdIndex: 0,
                accounts: [0, 1, 2, 3, 4],
                data: "Rhn86pnvWw7vtHC1NAPKQ1q1RAJeW2QhLCHffvbc2Co4bKmKs6EhGNt9UzjwheW58",
              },
            ],
          },
        ],
        loadedAddresses: {
          writable: [],
          readonly: [],
        },
      },
      transaction: {
        message: {
          accountKeys: [
            {
              pubkey: "FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u",
              signer: false,
            },
            {
              pubkey:
                "vault_acc7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZount",
              signer: false,
            },
            {
              pubkey: "98gqt9w7M9gZCEnN42HpbeRzaMst89fxdqXBFhuM4Njv",
              signer: true,
            },
            { pubkey: "11111111111111111111111111111111", signer: false },
            {
              pubkey: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
              signer: false,
            },
          ],
          instructions: [
            {
              programId: 0,
              accounts: [0, 1, 2, 3],
              data: "Rhn86pnvWw7vtHC1NAPKQ1q1RAJeW2QhLCHffvbc2Co4bKmKs6EhGNt9UzjwheW58",
            },
          ],
          getAccountKeys: () => ({
            staticAccountKeys: [
              {
                toBase58: () => "FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u",
              },
              {
                toBase58: () => "7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ",
              },
              {
                toBase58: () => "98gqt9w7M9gZCEnN42HpbeRzaMst89fxdqXBFhuM4Njv",
              },
              { toBase58: () => "11111111111111111111111111111111" },
              {
                toBase58: () => "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
              },
            ],
          }),
          compiledInstructions: [],
          addressTableLookups: [],
        },
      },
    };

    // Mock httpRpc to return the mock transaction
    (httpRpc as jest.Mock).mockImplementation(() => ({
      getTransaction: () => mockTransaction,
    }));

    // Create an instance of AttestationService
    const service = new AttestationService();

    // Call attestDepositoryDeposits with mock data
    const { messages } = await service.attestDepositoryDeposits({
      chainId: Object.values(await getChains())[0].id,
      transactionId: randomBase58(32),
    });

    // Verify the results
    expect(messages.length).toBe(1);
    const msg = messages[0];

    // Check the parsed message has the correct format and values
    expect(msg.result.currency).toBe(
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
    ); // System program ID for native SOL
    expect(msg.result.depositor).toBe(
      "98gqt9w7M9gZCEnN42HpbeRzaMst89fxdqXBFhuM4Njv"
    );
    expect(msg.result.depository).toBe(
      "FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u"
    );
    expect(msg.result.depositId).toBe(
      "0xd8dc6c585358c53b2cc109c3c31d8055c94a6e85622ea1196c2abe17a77dac0b"
    );
  });

  it("attestDepositoryDeposits - should attest native deposit instruction", async () => {
    const mockTransaction = {
      meta: {
        // Empty log messages to force instruction parsing
        logMessages: [],
        innerInstructions: [
          {
            index: 0,
            instructions: [
              {
                // deposit_native instruction
                programIdIndex: 0,
                accounts: [0, 1, 2, 3, 4],
                data: "VyPN4WGD269ghgoiH4ZzWJHyQFj3nEwGnPv9pFnbvDDP7Xkz83DDDoY5rLkX3VJhE",
              },
            ],
          },
        ],
        loadedAddresses: {
          writable: [],
          readonly: [],
        },
      },
      transaction: {
        message: {
          accountKeys: [
            {
              pubkey: "FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u",
              signer: false,
            },
            {
              pubkey:
                "vault_acc7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZount",
              signer: false,
            },
            {
              pubkey: "98gqt9w7M9gZCEnN42HpbeRzaMst89fxdqXBFhuM4Njv",
              signer: true,
            },
            { pubkey: "11111111111111111111111111111111", signer: false },
            {
              pubkey: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
              signer: false,
            },
          ],
          instructions: [
            {
              programId: 0,
              accounts: [0, 1, 2, 3],
              data: "Rhn86pnvWw7vtHC1NAPKQ1q1RAJeW2QhLCHffvbc2Co4bKmKs6EhGNt9UzjwheW58",
            },
          ],
          getAccountKeys: () => ({
            staticAccountKeys: [
              {
                toBase58: () => "FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u",
              },
              {
                toBase58: () => "7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ",
              },
              {
                toBase58: () => "98gqt9w7M9gZCEnN42HpbeRzaMst89fxdqXBFhuM4Njv",
              },
              { toBase58: () => "11111111111111111111111111111111" },
              {
                toBase58: () => "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
              },
            ],
          }),
          compiledInstructions: [],
          addressTableLookups: [],
        },
      },
    };

    // Mock httpRpc to return the mock transaction
    (httpRpc as jest.Mock).mockImplementation(() => ({
      getTransaction: () => mockTransaction,
    }));

    // Create an instance of AttestationService
    const service = new AttestationService();

    // Call attestDepositoryDeposits with mock data
    const { messages } = await service.attestDepositoryDeposits({
      chainId: Object.values(await getChains())[0].id,
      transactionId: randomBase58(32),
    });

    // Verify the results
    expect(messages.length).toBe(1);
    const msg = messages[0];

    // Check the parsed message has the correct format and values
    expect(msg.result.currency).toBe("11111111111111111111111111111111"); // System program ID for native SOL
    expect(msg.result.depositor).toBe(
      "98gqt9w7M9gZCEnN42HpbeRzaMst89fxdqXBFhuM4Njv"
    );
    expect(msg.result.depository).toBe(
      "FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u"
    );
    expect(msg.result.depositId).toBe(
      "0x0101010101010101010101010101010101010101010101010101010101010101"
    );
  });

  it("attestDepositoryDeposits - should return empty array when no events found", async () => {
    (httpRpc as jest.Mock).mockImplementation(() => ({
      getTransaction: () => ({
        meta: {
          logMessages: [],
        },
      }),
    }));

    const service = new AttestationService();
    const deposits = await service.attestDepositoryDeposits({
      chainId: Object.values(await getChains())[0].id,
      transactionId: randomBase58(32),
    });
    expect(deposits).toEqual([]);
  });

  it("attestDepositoryDeposits - should handle missing transaction", async () => {
    (httpRpc as jest.Mock).mockImplementation(() => ({
      getTransaction: () => null,
    }));

    const service = new AttestationService();
    const deposits = await service.attestDepositoryDeposits({
      chainId: Object.values(await getChains())[0].id,
      transactionId: randomBase58(32),
    });
    expect(deposits).toEqual([]);
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
      useSPLToken: true,
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
      useSPLToken: true,
    });
  });
});

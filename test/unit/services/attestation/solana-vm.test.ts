import { describe, expect, it, jest } from "@jest/globals";

import { randomBase58 } from "../../../common/utils";
import { Chain, getChains } from "../../../../src/common/chains";
import { httpRpc } from "../../../../src/common/vm/solana-vm/rpc";
import { AttestationService } from "../../../../src/services/attestation";
import { privateKeyToAccount } from "viem/accounts";
import { getOrderId, Order, SolverRefundStatus } from "@reservoir0x/relay-protocol-sdk";
import { Hex } from "viem";
import { randomHex, randomNumber } from "../../../common/utils";
import { PublicKey, TransactionResponse as SolanaTransactionResponse } from "@solana/web3.js";
import { RelayEscrowIdl } from "../../../../src/services/attestation/vm/solana-vm";
import { eventDiscriminator, BN } from "@coral-xyz/anchor";
import { IdlCoder } from '@coral-xyz/anchor/dist/cjs/coder/borsh/idl';

type TransactionResponse = SolanaTransactionResponse;

const zeroAddress = "11111111111111111111111111111111";
const testSolverPrivateKey =
  "0x1234567890123456789012345678901234567890123456789012345678901234";
const solverWallet = privateKeyToAccount(testSolverPrivateKey);

function encodeEventData(eventName: string, args: any, idl: any = RelayEscrowIdl): string {
  const eventTypeDef = idl.events.find((e: any) => e.name === eventName);
  if (!eventTypeDef) {
    throw new Error(`Event not found: ${eventName}`);
  }
  
  // Create the layout for this specific event
  const layout = IdlCoder.typeDefLayout(
    {
      name: eventName,
      type: {
        kind: "struct",
        fields: eventTypeDef.fields.map((f: any) => {
          return { name: f.name, type: f.type };
        }),
      },
    } as any, 
    idl.types as any
  );
  
  // Encode the event data
  const buffer = Buffer.alloc(1000); // Allocate a large enough buffer
  const len = layout.encode(args, buffer);
  
  // Combine discriminator and encoded data
  return Buffer.concat([
    eventDiscriminator(eventName),
    buffer.slice(0, len)
  ]).toString('base64');
}

// function decodeEventData(eventData: Buffer, eventName: string, idl: any = RelayEscrowIdl): any {
//   // First 8 bytes are the discriminator
//   const discriminator = eventData.slice(0, 8);
//   const expectedDiscriminator = eventDiscriminator(eventName);
  
//   // Verify discriminator matches the expected event
//   if (!discriminator.equals(expectedDiscriminator)) {
//     throw new Error(`Event discriminator mismatch: expected ${expectedDiscriminator.toString('base64')}, got ${discriminator.toString('base64')}`);
//   }
  
//   const eventTypeDef = idl.events.find((e: any) => e.name === eventName);
//   if (!eventTypeDef) {
//     throw new Error(`Event not found: ${eventName}`);
//   }
  
//   // Create the layout for this specific event
//   const layout = IdlCoder.typeDefLayout(
//     {
//       name: eventName,
//       type: {
//         kind: "struct",
//         fields: eventTypeDef.fields.map((f: any) => {
//           return { name: f.name, type: f.type };
//         }),
//       },
//     } as any, 
//     idl.types as any
//   );
  
//   // Decode the event data (skipping the 8-byte discriminator)
//   return layout.decode(eventData.slice(8));
// }

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
      key => key.toBase58() === options.paymentRecipient
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
  
  if (options?.tokenMint && options?.paymentRecipient && options?.paymentAmount) {
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
          uiAmountString: initialTokenAmount
        }
      }
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
          uiAmountString: finalTokenAmount
        }
      }
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
          staticAccountKeys: keys
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

  const logData = encodeEventData('DepositEvent', {
    depositor: new PublicKey(from),
    token: new PublicKey(tokenAddress),
    amount: new BN(amount),
    id: Buffer.from(Array(32).fill(1))
  });

  // Create memo instruction containing order hash
  const memoInstruction = {
    programIdIndex: 0, // Index of the memo program in the accountKeys array
    accountKeyIndexes: [],
    data: Buffer.from(orderHash, 'utf-8'),
  };

  // Create account keys including memo program and token accounts
  const accountKeys = [
    new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), // Memo program
    new PublicKey(to), // Recipient
    new PublicKey(from), // Sender
    new PublicKey(tokenAddress), // Token mint
    new PublicKey(zeroAddress), // Token program
  ];

  // Create token balances to simulate SPL token transfer
  const preTokenBalances = [
    {
      accountIndex: 1, // Recipient
      mint: tokenAddress,
      owner: to,
      uiTokenAmount: {
        amount: "0",
        decimals: 9,
        uiAmount: 0,
        uiAmountString: "0",
      }
    },
    {
      accountIndex: 2, // Sender
      mint: tokenAddress,
      owner: from,
      uiTokenAmount: {
        amount: amount,
        decimals: 9,
        uiAmount: parseFloat(amount) / 1e9,
        uiAmountString: (parseFloat(amount) / 1e9).toString(),
      }
    }
  ];

  const postTokenBalances = [
    {
      accountIndex: 1, // Recipient
      owner: to,
      mint: tokenAddress,
      uiTokenAmount: {
        amount: amount,
        decimals: 9,
        uiAmount: parseFloat(amount) / 1e9,
        uiAmountString: (parseFloat(amount) / 1e9).toString(),
      }
    },
    {
      accountIndex: 2, // Sender
      mint: tokenAddress,
      owner: from,
      uiTokenAmount: {
        amount: "0",
        decimals: 9,
        uiAmount: 0,
        uiAmountString: "0",
      }
    }
  ];

  // Generate transaction with SPL token balance changes
  return generateTransactionResponse(
    transactionHash,
    [`Program log: SPL Transfer executed for order: ${orderHash}`, `Program data: ${logData}`], 
    [memoInstruction],
    accountKeys,
    {
      tokenMint: tokenAddress,
      preTokenBalances,
      postTokenBalances
    }
  );
};

// Create deposit transaction logs
function createDepositTransaction(params: {
  depositTxHash: string;
  depositorAddress: string;
  escrowAddress: string;
  tokenAddress: string;
  paymentAmount: string;
}): TransactionResponse {
  const logData = encodeEventData('DepositEvent', {
    depositor: new PublicKey(params.depositorAddress),
    token: null,
    amount: new BN(params.paymentAmount),
    id: Buffer.from(Array(32).fill(1))
  });
  const { depositTxHash } = params;
  return generateTransactionResponse(depositTxHash, ['Program data: ' + logData]);
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
    orderHash
  } = params;
  
  // Create memo instruction containing order hash
  const memoInstruction = {
    programIdIndex: 0, // Index of the memo program in the accountKeys array
    accountKeyIndexes: [],
    data: Buffer.from(orderHash, 'utf-8'),
  };

  // Create account keys including memo program and recipient
  const accountKeys = [
    new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), // Memo program
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
      paymentAmount: paymentAmount
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
    orderHash
  } = params;
  
  // Create memo instruction containing order hash
  const memoInstruction = {
    programIdIndex: 0, // Index of the memo program in the accountKeys array
    accountKeyIndexes: [],
    data: Buffer.from(orderHash, 'utf-8'),
  };

  // Create account keys including memo program and recipient
  const accountKeys = [
    new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), // Memo program
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
      paymentAmount: paymentAmount
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
            extraData: '0x',
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
      extraData: '0x',
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
  const tokenAddress = randomBase58(32)
  const paymentAmount = randomNumber(1e10).toString();
  const outputRecipient = randomBase58(32)
  const refundRecipient = randomBase58(32)
  const solverContractAddress = randomBase58(32)

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
const setupTestEnvironment = async (options: {
  useSPLToken?: boolean;
  invalidSignature?: boolean;
  expiredDeadline?: boolean;
  insufficientPayment?: boolean;
  duplicateOnchainIds?: boolean;
  customPaymentAmount?: string;
  actionType?: 'fill' | 'refund';
} = {}) => {
  const chains = Object.values(await getChains());
  const testData = setupTestData();
  testData.chain = chains.find((chain) => chain.id === "solana");
  
  const depositTxHash = randomBase58(32);
  const actionTxHash = randomBase58(32); // Can be either fill or refund transaction hash
  
  // Adjust payment amount if specified
  const paymentAmount = options.customPaymentAmount || testData.paymentAmount;
  const fillAmount = options.insufficientPayment 
    ? (BigInt(paymentAmount) * 50n / 100n).toString() // 50% of required amount
    : paymentAmount;
  
  // Create deposit transaction
  let depositTxReceipt: TransactionResponse;
  if (options.useSPLToken) {
    depositTxReceipt = createSPLTransferTransaction({
      transactionHash: depositTxHash,
      from: testData.depositorAddress,
      to: testData.chain.escrow,
      tokenAddress: testData.tokenAddress,
      amount: paymentAmount,
      orderHash: '0x1234567890abcdef',
    });
  } else {
    depositTxReceipt = createDepositTransaction({
      depositTxHash,
      depositorAddress: testData.depositorAddress,
      escrowAddress: testData.chain.escrow,
      tokenAddress: testData.tokenAddress,
      paymentAmount,
    });
  }
  
  // Create test order
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

  console.log('testOrder', testOrder)

  const orderHash = getOrderId(testOrder, {
    "solana": "solana-vm",
    "ethereum": "ethereum-vm"
  });
  
  // Create action transaction receipt (fill or refund)
  let actionTxReceipt: TransactionResponse;
  const isRefund = options.actionType === 'refund';
  
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
    currentTimestamp: options.expiredDeadline ? Math.floor(Date.now() / 1000) : testData.currentTimestamp,
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
  
  // Get escrow deposits
  const escrowDeposits = await new AttestationService().attestEscrowDeposits({
    chainId: testData.chain.id,
    transactionId: depositTxHash,
  });

  // Create inputs array
  const inputs = options.duplicateOnchainIds
    ? [
        {
          transactionId: depositTxHash,
          onchainId: escrowDeposits[0].result.onchainId,
          inputIndex: 0,
        },
        {
          transactionId: depositTxHash,
          onchainId: escrowDeposits[0].result.onchainId, // Duplicate onchainId
          inputIndex: 0,
        },
      ]
    : [
        {
          transactionId: depositTxHash,
          onchainId: escrowDeposits[0].result.onchainId,
          inputIndex: 0,
        },
      ];
  
  return {
    testData,
    depositTxHash,
    actionTxHash,
    testOrder,
    orderSignature,
    escrowDeposits,
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
      return receipt
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
  const env = await setupTestEnvironment({...options, actionType: 'fill'});
  
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
    
    expect(solverFillResult.result.status).toBe(SolverRefundStatus.SUCCESSFUL);
    expect(solverFillResult.result.totalWeightedInputPaymentBpsDiff).toBe("0");
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
  const env = await setupTestEnvironment({...options, actionType: 'refund'});
  
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
    const solverRefundResult = await new AttestationService().attestSolverRefund({
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
    
    expect(solverRefundResult.result.status).toBe(SolverRefundStatus.SUCCESSFUL);
    expect(solverRefundResult.result.totalWeightedInputPaymentBpsDiff).toBe("0");
    return solverRefundResult;
  }
};

jest.mock("../../../../src/common/chains", () => {
  const chains: Record<string, Chain> = {
    solana: {
      id: "solana",
      vmType: "solana-vm",
      httpRpcUrl: "http://127.0.0.1:8545",
      escrow: "FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u",
    },
    ethereum: {
      id: "ethereum",
      vmType: "ethereum-vm",
      httpRpcUrl: "http://127.0.0.1:8546",
      escrow: "0x2e988a386a799f506693793c6a5af6b54dfaabfb",
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

describe("SolanaAttestationService", () => {
  it("attestEscrowDeposits - should attest spl-token deposit event", async () => {
    const logs = [
      "Program FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u invoke [1]",
      "Program log: Instruction: DepositToken",
      "Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL invoke [2]",
      "Program log: Create",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [3]",
      "Program log: Instruction: GetAccountDataSize",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 1595 of 171961 compute units",
      "Program return: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA pQAAAAAAAAA=",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success",
      "Program 11111111111111111111111111111111 invoke [3]",
      "Program 11111111111111111111111111111111 success",
      "Program log: Initialize the associated token account",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [3]",
      "Program log: Instruction: InitializeImmutableOwner",
      "Program log: Please upgrade to SPL Token 2022 for immutable owner support",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 1405 of 165348 compute units",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [3]",
      "Program log: Instruction: InitializeAccount3",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 4214 of 161464 compute units",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success",
      "Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL consumed 20490 of 177436 compute units",
      "Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL success",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]",
      "Program log: Instruction: Transfer",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 4645 of 154583 compute units",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success",
      "Program data: ePg9Ux+Oa5BKhcPIo5YCxfVvqfPz933GfySoNJT1XBm7C56dKEjbtgECj6a+uZgbJKIbAmd7tEbJyCWUKmAw0BsVRHOkEgXc4gDKmjsAAAAAAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
      "Program FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u consumed 50781 of 200000 compute units",
      "Program FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u success",
    ];

    (httpRpc as jest.Mock).mockImplementation(() => ({
      getParsedTransaction: () => ({
        meta: {
          logMessages: logs,
        },
      }),
    }));

    const service = new AttestationService();
    const messages = await service.attestEscrowDeposits({
      chainId: Object.values(await getChains())[0].id,
      transactionId: randomBase58(32),
    });
    const msg = messages[0];

    expect(messages.length).toBe(1);
    expect(msg.result.currency).toBe(
      "AzrxfjSRgePBiRyHoV4mdUX2LVTxwPR9E1Crr9mZVeH"
    );
    expect(msg.result.amount).toBe("1000000000");
    expect(msg.result.depositor).toBe(
      "61uUNRFVyDQsyne2cHzEmjA76UYpfsRKi2EaDoYH64Rs"
    );
    expect(msg.result.escrow).toBe(
      "FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u"
    );
    expect(msg.result.depositId).toBe(
      "0202020202020202020202020202020202020202020202020202020202020202"
    );
  });

  it("attestEscrowDeposits - should attest native deposit event", async () => {
    const logs = [
      "Program FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u invoke [1]",
      "Program log: Instruction: DepositSol",
      "Program 11111111111111111111111111111111 invoke [2]",
      "Program 11111111111111111111111111111111 success",
      "Program data: ePg9Ux+Oa5B41ZyI3pX01JFl6AV6P2HoW3/Z+7eGs9orfK3r4gNo5QAAypo7AAAAAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB",
      "Program FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u consumed 11114 of 200000 compute units",
      "Program FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u success",
    ];

    (httpRpc as jest.Mock).mockImplementation(() => ({
      getParsedTransaction: () => ({
        meta: {
          logMessages: logs,
        },
      }),
    }));

    const service = new AttestationService();
    const messages = await service.attestEscrowDeposits({
      chainId: Object.values(await getChains())[0].id,
      transactionId: randomBase58(32),
    });
    const msg = messages[0];

    expect(messages.length).toBe(1);
    expect(msg.result.currency).toBe("11111111111111111111111111111111");
    expect(msg.result.amount).toBe("1000000000");
    expect(msg.result.depositor).toBe(
      "98gqt9w7M9gZCEnN42HpbeRzaMst89fxdqXBFhuM4Njv"
    );
    expect(msg.result.escrow).toBe(
      "FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u"
    );
    expect(msg.result.depositId).toBe(
      "0101010101010101010101010101010101010101010101010101010101010101"
    );
  });

  it("attestEscrowDeposits - should return empty array when no events found", async () => {
    (httpRpc as jest.Mock).mockImplementation(() => ({
      getParsedTransaction: () => ({
        meta: {
          logMessages: [],
        },
      }),
    }));

    const service = new AttestationService();
    const deposits = await service.attestEscrowDeposits({
      chainId: Object.values(await getChains())[0].id,
      transactionId: randomBase58(32),
    });
    expect(deposits).toEqual([]);
  });

  it("attestEscrowDeposits - should handle missing transaction", async () => {
    (httpRpc as jest.Mock).mockImplementation(() => ({
      getParsedTransaction: () => null,
    }));

    const service = new AttestationService();
    const deposits = await service.attestEscrowDeposits({
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
      expectError: "Invalid order signature" 
    });
  });

  it("attestSolverFill - fails with non-unique onchain ids", async () => {
    await testAttestSolverFill({ 
      duplicateOnchainIds: true, 
      expectError: "Input information contains non-unique onchain ids" 
    });
  });

  it("attestSolverFill - fails with insufficient fill amount", async () => {
    await testAttestSolverFill({ 
      insufficientPayment: true, 
      expectError: "Insufficient fill amount for order output payment" 
    });
  });

  it("attestSolverFill - fails with expired output deadline", async () => {
    await testAttestSolverFill({ 
      expiredDeadline: true, 
      expectError: "deadline" 
    });
  });

  it("attestSolverFill - validates with ERC20 token payments", async () => {
    await testAttestSolverFill({ 
      useSPLToken: true 
    });
  });

  it("attestSolverRefund - validates solver refund correctly", async () => {
    await testAttestSolverRefund({});
  });
  
  it("attestSolverRefund - fails with invalid order signature", async () => {
    await testAttestSolverRefund({ 
      invalidSignature: true, 
      expectError: "Invalid order signature" 
    });
  });
  
  it("attestSolverRefund - validates with ERC20 token payments", async () => {
    await testAttestSolverRefund({ 
      useSPLToken: true 
    });
  });
});

import { describe, expect, it, jest } from "@jest/globals";

import { randomBs58 } from "../../../common/utils";
import { getChains } from "../../../../src/common/chains";
import { httpRpc } from "../../../../src/common/vm/solana-vm/rpc";
import { AttestationService } from "../../../../src/services/attestation";
import { privateKeyToAccount } from "viem/accounts";
import { getOrderHash, Order } from "@reservoir0x/relay-protocol-sdk";
import {
  Hex,
  zeroAddress,
} from "viem";
import { randomHex, randomNumber } from "../../../common/utils";
import { PublicKey, TransactionResponse as SolanaTransactionResponse } from "@solana/web3.js";
import { RelayEscrowIdl } from "../../../../src/services/attestation/vm/solana-vm";
import { eventDiscriminator, BN } from "@coral-xyz/anchor";
import { IdlCoder } from '@coral-xyz/anchor/dist/cjs/coder/borsh/idl';

type TransactionResponse = SolanaTransactionResponse;

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
  logs: string[]
): TransactionResponse => {
  return {
    slot: randomNumber(1e10),
    blockTime: Math.floor(Date.now() / 1000), // Adding blockTime
    meta: {
      err: null,
      fee: randomNumber(1e6),
      preBalances: [],
      postBalances: [],
      innerInstructions: [],
      logMessages: logs,
      preTokenBalances: [],
      postTokenBalances: [],
      loadedAddresses: {
        readonly: [],
        writable: [],
      },
    },
    transaction: {
      signatures: [transactionHash],
      message: {
        accountKeys: [], // Ideally convert to PublicKey objects if needed
        recentBlockhash: randomBs58(10),
        instructions: [],
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 0,
        },
      } as any, // Type assertion to satisfy Transaction.message type
    },
  };
};

const createSPLTransferTransaction = ({
  // transactionHash,
  // from,
  // to,
  // tokenAddress,
  // amount,
}: {
  transactionHash: string;
  from: string;
  to: string;
  tokenAddress: string;
  amount: string;
}): TransactionResponse => {
  throw new Error("Not implemented");
  // const transferLog = generateTransferLog({
  //   transactionHash,
  //   logIndex: 0,
  //   from,
  //   to,
  //   token: tokenAddress,
  //   amount,
  // });
  
  // return generateTransactionReceipt(transactionHash, [transferLog]);
};

// Create deposit transaction logs
function createDepositTransaction(params: {
  depositTxHash: string;
  depositorAddress: string;
  escrowAddress: string;
  tokenAddress: string;
  paymentAmount: string;
}): TransactionResponse {
  // const types = RelayEscrowIdl.types;
  // const idl = RelayEscrowIdl
  // const layouts: any[] = idl.events.map((event) => {
  //   let eventTypeDef = {
  //     name: event.name,
  //     type: {
  //       kind: "struct",
  //       fields: event.fields.map((f) => {
  //         return { name: f.name, type: f.type };
  //       }),
  //     },
  //   };
  //   return [event.name, IdlCoder.typeDefLayout(eventTypeDef as any, idl.types as any)];
  // });

  // const discriminators = idl.events.map((e) => [
  //   eventDiscriminator(e.name).toString('base64'),
  //   e.name,
  // ] as const);

  // const logArr = Buffer.from('XAqyuBIseHyD6q3CsL4+q/8vpriI7Znwv82QTXEgc/7YdToVNNU48AAA4fUFAAAAAOR/ngmWAQAAQxXyZwAAAAC6wUYM1quIijgngodEMdwvpDcpi1C1upEEr7d/coYFjYmNNdNGyIwr7uBGBuJEKw0NK1Ht/OvBhp4dbV4JCJaV', 'base64');
  // const discId = logArr.slice(0, 8).toString('base64');
  // console.log('params', params, layouts[0][1].encode)

  // const buffer = Buffer.alloc(1000);
  // const [
  //   eventName,
  //   layout
  // ] = layouts[0];

  const logData = encodeEventData('DepositEvent', {
    depositor: new PublicKey(params.depositorAddress),
    token: null,
    amount: new BN(params.paymentAmount),
    id: Buffer.from(Array(32).fill(1))
  });

  console.log('logData', logData)

  // encodeEventData('TransferExecutedEvent',
  //   {
  //     request: {
  //       recipient: new PublicKey(params.depositorAddress),
  //       token: null,
  //       amount: new BN(params.paymentAmount),
  //       nonce: new BN(1),
  //       expiration: new BN(Math.floor(Date.now() / 1000) + 36000),
  //     },
  //     executor: new PublicKey(randomBs58(32)),
  //     id: new PublicKey(randomBs58(32)),
  //   }
  // )
  // const len = layout.encode({
  //   request: {
  //     recipient: new PublicKey(params.depositorAddress),
  //     token: null,
  //     amount: new BN(params.paymentAmount),
  //     nonce: new BN(1),
  //     expiration: new BN(Math.floor(Date.now() / 1000) + 36000),
  //   },
  //   executor: new PublicKey(randomBs58(32)),
  //   id: new PublicKey(randomBs58(32)),
  // }, buffer);

  // console.log('eventData', 
  //   Buffer.concat([
  //     eventDiscriminator(eventName),
  //     buffer.slice(0, len)
  //   ]).toString('base64')
  // )
  // console.log('disc',  discId, layouts[0][1].decode(logArr.slice(8)))
  // const layouts = RelayEscrowIdl.events.map((ev) => {
  //   // const typeDef = RelayEscrowIdl.types.find((ty) => ty.name === ev.name);
  //   // console.log('typeDef', typeDef)
  //   // if (!typeDef) {
  //   //   throw new Error(`Event not found: ${ev.name}`);
  //   // }
  //   return [
  //     ev.name,
  //     {
  //       discriminator: eventDiscriminator(ev.name),
  //       // layout: IdlCoder.typeDefLayout(typeDef as any, types as any, ev.name),
  //     },
  //   ] as const;
  // });
  // console.log('layouts', layouts, discriminators)
  // throw new Error("Not implemented");
  const { 
    depositTxHash, 
    // depositorAddress, 
    // escrowAddress, tokenAddress, 
    // paymentAmount 
  } = params;
  // const depositTransferLog = generateTransferLog({
  //   transactionHash: depositTxHash,
  //   logIndex: 0,
  //   from: depositorAddress,
  //   to: escrowAddress,
  //   token: tokenAddress,
  //   amount: paymentAmount,
  // });
 
  return generateTransactionResponse(depositTxHash, ['Program data: ' + logData]);
}

// Create refund transaction logs
function createRefundTransaction(params: {
  refundTxHash: string;
  refundRecipient: string;
  solverContractAddress: string;
  paymentAmount: string;
}): TransactionResponse {
  // throw new Error("Not implemented");
  const { refundTxHash, 
    // refundRecipient, solverContractAddress, paymentAmount
   } = params;
  
  // const refundNativeTransferLog = generateSolverNativeTransferLog({
  //   transactionHash: refundTxHash,
  //   logIndex: 0,
  //   from: refundRecipient,
  //   to: solverContractAddress,
  //   amount: paymentAmount,
  // });
  
  return generateTransactionResponse(refundTxHash, ['']);
}

// Create fill transaction logs
function createFillTransaction(params: {
  fillTxHash: string;
  outputRecipient: string;
  solverContractAddress: string;
  paymentAmount: string;
}): TransactionResponse {
  // throw new Error("Not implemented");
  const { fillTxHash, 
    // outputRecipient, solverContractAddress, paymentAmount 
  } = params;
  
  // const fillNativeTransferLog = generateSolverNativeTransferLog({
  //   transactionHash: fillTxHash,
  //   logIndex: 0,
  //   from: outputRecipient,
  //   to: solverContractAddress,
  //   amount: paymentAmount,
  // });
  
  return generateTransactionResponse(fillTxHash, ['']);
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
            extraData: '0x',
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
  const depositorAddress = randomBs58(32);
  const tokenAddress = randomBs58(32)
  const paymentAmount = randomNumber(1e10).toString();
  const outputRecipient = randomBs58(32)
  const refundRecipient = randomBs58(32)
  const solverContractAddress = randomBs58(32)

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
  testData.chain = chains[randomNumber(chains.length)];
  
  const depositTxHash = randomBs58(32);
  const actionTxHash = randomBs58(32); // Can be either fill or refund transaction hash
  
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
  const vmType = "solana-vm";
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
  
  const orderHash = getOrderHash(testOrder, {
    1000: vmType,
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
          onchainId: escrowDeposits[0].onchainId,
          inputIndex: 0,
        },
        {
          transactionId: depositTxHash,
          onchainId: escrowDeposits[0].onchainId, // Duplicate onchainId
          inputIndex: 0,
        },
      ]
    : [
        {
          transactionId: depositTxHash,
          onchainId: escrowDeposits[0].onchainId,
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
    
    expect(solverFillResult.result.validated).toBe(true);
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
    
    expect(solverRefundResult.result.validated).toBe(true);
    expect(solverRefundResult.result.totalWeightedInputPaymentBpsDiff).toBe("0");
    return solverRefundResult;
  }
};

jest.mock("../../../../src/common/chains", () => {
  const chains: Record<number, any> = {
    1000: {
      id: 1000,
      name: "Test",
      vmType: "solana-vm",
      httpRpcUrl: "http://127.0.0.1:8545",
      escrow: "FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u",
    },
  };
  return {
    getChains: () => chains,
    getChain: (chainId: number) => chains[chainId],
  };
});
jest.mock("../../../../src/common/vm/solana-vm/rpc", () => {
  return {
    httpRpc: jest.fn(),
  };
});

describe("SolanaAttestationService", () => {
  it("attestEscrowDeposits - should attest transfer executed event", async () => {
    const logs = [
      "Program FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u invoke [1]",
      "Program log: Instruction: ExecuteTransfer",
      "Program data: XAqyuBIseHyD6q3CsL4+q/8vpriI7Znwv82QTXEgc/7YdToVNNU48AAA4fUFAAAAAOR/ngmWAQAAQxXyZwAAAAC6wUYM1quIijgngodEMdwvpDcpi1C1upEEr7d/coYFjYmNNdNGyIwr7uBGBuJEKw0NK1Ht/OvBhp4dbV4JCJaV",
    ];

    (httpRpc as jest.Mock).mockImplementation(() => ({
      getParsedTransaction: () => ({
        meta: {
          logMessages: logs,
        },
      }),
    }));

    const service = new AttestationService();
    const messages = await service.attestEscrowWithdrawals({
      chainId: Object.values(await getChains())[0].id,
      transactionId: randomBs58(32),
    });

    expect(messages.length).toBe(1);
    expect(messages[0].result.currency).toBe(
      "11111111111111111111111111111111"
    );
    expect(messages[0].result.amount).toBe("100000000");
    expect(messages[0].result.withdrawalId).toBe(
      "AFwk1wX1efTqiV37seaAzJAKHjjUDZxeKnfBU5p6wmbJ"
    );
  });

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
      transactionId: randomBs58(32),
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
      transactionId: randomBs58(32),
    });
    const msg = messages[0];

    expect(messages.length).toBe(1);
    expect(msg.result.currency).toBe("11111111111111111111111111111111");
    expect(msg.result.amount).toBe("1000000000");
    expect(msg.result.depositor).toBe(
      "98gqt9w7M9gZCEnN42HpbeRzaMst89fxdqXBFhuM4Njv"
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
      transactionId: randomBs58(32),
    });
    expect(deposits).toEqual([]);
  });

  it("attestEscrowWithdrawals - should return empty array when no events found", async () => {
    (httpRpc as jest.Mock).mockImplementation(() => ({
      getParsedTransaction: () => ({
        meta: {
          logMessages: [],
        },
      }),
    }));

    const service = new AttestationService();
    const deposits = await service.attestEscrowWithdrawals({
      chainId: Object.values(await getChains())[0].id,
      transactionId: randomBs58(32),
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
      transactionId: randomBs58(32),
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
    console.log('xxx', Buffer.from('HbJBtg4wSXXwV5UoLkNpjLbLC2ZCS2AiPp3nhGXxcpdd', 'utf8'))
    console.log('xxx', Buffer.from(Buffer.from('HbJBtg4wSXXwV5UoLkNpjLbLC2ZCS2AiPp3nhGXxcpdd', 'utf8')).toString('utf8'))
    await testAttestSolverRefund({ 
      useSPLToken: true 
    });
  });
});

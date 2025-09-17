import { describe, expect, it, jest } from "@jest/globals";

import { randomBase58, randomHex, randomNumber } from "../../../common/utils";
import { Chain, getChains } from "../../../../src/common/chains";
import { httpRpc } from "../../../../src/common/vm/sui-vm/rpc";
import { AttestationService } from "../../../../src/services/attestation";
import { privateKeyToAccount } from "viem/accounts";
import {
  getOrderId,
  Order,
  SolverRefundStatus,
  SolverFillStatus,
} from "@reservoir0x/relay-protocol-sdk";
import { Hex } from "viem";

type TransactionResponse = {
  digest: string;
  timestampMs: number;
  effects: {
    status: { status: string };
  };
  events: any[];
  balanceChanges: any[];
};

// const zeroAddress = "0x2::sui::SUI";
const zeroAddress = "0x2";
const testSolverPrivateKey =
  "0x1234567890123456789012345678901234567890123456789012345678901234";
const solverWallet = privateKeyToAccount(testSolverPrivateKey);

const generateTransactionResponse = (
  transactionHash: string,
  events: any[],
  options?: {
    paymentRecipient?: string;
    paymentAmount?: string;
    coinType?: string;
  }
): TransactionResponse => {
  return {
    digest: transactionHash,
    timestampMs: Date.now(),
    effects: {
      status: { status: "success" },
    },
    events: events,
    balanceChanges: options?.paymentAmount ? [
      {
        owner: {
          AddressOwner: options.paymentRecipient
        },
        coinType: options.coinType || zeroAddress,
        amount: options.paymentAmount
      }
    ] : [],
  };
};

function createDepositEvent(params: {
  depositorAddress: string;
  amount: string;
  coinType?: string;
  depositId?: number[];
}) {
  const depositId = params.depositId || Array(32).fill(3);
  return {
    id: {
      txDigest: randomBase58(32),
      eventSeq: "0",
    },
    packageId: "0x0b50c9a37ec3e171b115455e73158c6aa2d7d079bf2915720f022457dc987bd4",
    transactionModule: "escrow",
    sender: params.depositorAddress,
    type: "0x0b50c9a37ec3e171b115455e73158c6aa2d7d079bf2915720f022457dc987bd4::escrow::DepositEvent",
    parsedJson: {
      amount: params.amount,
      coin_type: {
        name: params.coinType || "0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
      },
      deposit_id: depositId,
      from: params.depositorAddress,
    },
    bcsEncoding: "base64",
    bcs: ""
  };
}

function createMemoEvent(params: {
  orderHash: string
}) {
  return {
    id: {
      txDigest: randomBase58(32),
      eventSeq: "0",
    },
    packageId: "0x0b50c9a37ec3e171b115455e73158c6aa2d7d079bf2915720f022457dc987bd4",
    transactionModule: "escrow",
    sender: randomHex(32),
    type: "0x0b50c9a37ec3e171b115455e73158c6aa2d7d079bf2915720f022457dc987bd4::memo::MemoEvent",
    parsedJson: {
      message: params.orderHash
    },
    bcsEncoding: "base64",
    bcs: ""
  };
}

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

  const event = createDepositEvent({
    depositorAddress: from,
    amount: amount,
    coinType: tokenAddress
  });

  const memoEvent = createMemoEvent({
    orderHash
  });

  // Generate transaction with SPL token balance changes
  return generateTransactionResponse(
    transactionHash,
    [
      event,
      memoEvent
    ],
    {
      paymentRecipient: to,
      coinType: tokenAddress,
      paymentAmount: amount
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
  const event = createDepositEvent({
    depositorAddress: params.depositorAddress,
    amount: params.paymentAmount,
  });
  return generateTransactionResponse(params.depositTxHash, [event]);
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
    paymentAmount,
    orderHash
  } = params;

  const memoEvent = createMemoEvent({
    orderHash
  });

  // Generate transaction with balance changes showing payment to the recipient
  return generateTransactionResponse(
    refundTxHash,
    [
      memoEvent
    ],
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
    paymentAmount,
    orderHash
  } = params;

  const memoEVent = createMemoEvent({
    orderHash
  });

  // Generate transaction with balance changes showing payment to the recipient
  return generateTransactionResponse(
    fillTxHash,
    [
      memoEVent
    ], 
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
          chainId: "sui",
          currency: inputCurrency,
          amount: paymentAmount,
          weight: "1",
        },
        refunds: [
          {
            chainId: "sui",
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
      chainId: "sui",
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
  const depositorAddress = randomHex(32);
  const tokenAddress = randomHex(32)
  const paymentAmount = randomNumber(1e10).toString();
  const outputRecipient = randomHex(32)
  const refundRecipient = randomHex(32)
  const solverContractAddress = randomHex(32)

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
  useCoin?: boolean;
  invalidSignature?: boolean;
  expiredDeadline?: boolean;
  insufficientPayment?: boolean;
  duplicateOnchainIds?: boolean;
  customPaymentAmount?: string;
  actionType?: 'fill' | 'refund';
} = {}) => {
  const chains = Object.values(await getChains());
  const testData = setupTestData();
  testData.chain = chains.find((chain) => chain.id === "sui");
  
  const depositTxHash = randomBase58(32);
  const actionTxHash = randomBase58(32); // Can be either fill or refund transaction hash
  
  // Adjust payment amount if specified
  const paymentAmount = options.customPaymentAmount || testData.paymentAmount;
  const fillAmount = options.insufficientPayment 
    ? (BigInt(paymentAmount) * 50n / 100n).toString() // 50% of required amount
    : paymentAmount;
  
  // Create deposit transaction
  let depositTxReceipt: TransactionResponse;
  if (options.useCoin) {
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
    inputCurrency: options.useCoin ? testData.tokenAddress : zeroAddress,
    outputCurrency: options.useCoin ? testData.tokenAddress : zeroAddress,
  });
  
  // Set expired deadline if specified
  if (options.expiredDeadline) {
    testOrder.output.deadline = Math.floor(Date.now() / 1000) - 3600; // 1 hour in the past
  }

  const orderHash = getOrderId(testOrder, {
    "sui": "sui-vm",
    "ethereum": "ethereum-vm"
  });
  
  // Create action transaction receipt (fill or refund)
  let actionTxReceipt: TransactionResponse;
  const isRefund = options.actionType === 'refund';

  if (options.useCoin) {
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
    getTransactionBlock: ({
      digest
    }: {
      digest: string
    }) => {
      const txData = mockRpcData.transactions[digest]?.receipt;
      if (!txData) {
        throw new Error(`Invalid transaction ID: ${digest}`);
      }
      return txData;
    }
  }));
}

/**
 * Test attestSolverFill with various configurations
 * @param options Configuration options for the fill test
 * @returns Test result or error
 */
const testAttestSolverFill = async (options: {
  useCoin?: boolean;
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
    
    expect(solverFillResult.result.status).toBe(SolverFillStatus.SUCCESSFUL);
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
  useCoin?: boolean;
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
    sui: {
      id: "sui",
      vmType: "sui-vm",
      httpRpcUrl: "http://127.0.0.1:9000",
      depository:
        "0x9d2a84411e00bcc5f39fd137521106b2a968ee7998db999203bc598f69c7d28e",
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
jest.mock("../../../../src/common/vm/sui-vm/rpc", () => {
  return {
    httpRpc: jest.fn(),
  };
});

describe("SuiVmAttestor", () => {
  it("attestDepositoryDeposits - should attest deposit event", async () => {
    const events = [
      {
        id: {
          txDigest: "2p3QBA3rXV6VSQBsu8SmtEnaWSXAu7P9p5xEPaDDz6sE",
          eventSeq: "0",
        },
        packageId:
          "0x0b50c9a37ec3e171b115455e73158c6aa2d7d079bf2915720f022457dc987bd4",
        transactionModule: "depository",
        sender:
          "0x5f7f85e64cb90f4fad427c119cfcfe916397e6f559e052e686df05fe561f9f80",
        type: "0x0b50c9a37ec3e171b115455e73158c6aa2d7d079bf2915720f022457dc987bd4::depository::DepositEvent",
        parsedJson: {
          amount: "3000",
          coin_type: {
            name: "0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
          },
          deposit_id: [
            3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
            3, 3, 3, 3, 3, 3, 3, 3, 3,
          ],
          from: "0x5f7f85e64cb90f4fad427c119cfcfe916397e6f559e052e686df05fe561f9f80",
        },
        bcsEncoding: "base64",
        bcs: "SjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDI6OnN1aTo6U1VJuAsAAAAAAABff4XmTLkPT61CfBGc/P6RY5fm9VngUuaG3wX+Vh+fgCADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw==",
      },
    ];

    (httpRpc as jest.Mock).mockImplementation(() => ({
      getTransactionBlock: () => ({
        events,
      }),
    }));

    const service = new AttestationService();
    const messages = await service.attestDepositoryDeposits({
      chainId: Object.values(await getChains())[0].id,
      transactionId: randomBase58(20),
    });
    const msg = messages[0];

    expect(messages.length).toBe(1);
    expect(msg.result.currency).toBe(
      "0000000000000000000000000000000000000000000000000000000000000002::sui::SUI"
    );
    expect(msg.result.amount).toBe("3000");
    expect(msg.result.depositor).toBe(
      "0x5f7f85e64cb90f4fad427c119cfcfe916397e6f559e052e686df05fe561f9f80"
    );
    expect(msg.result.depository).toBe(
      "0x9d2a84411e00bcc5f39fd137521106b2a968ee7998db999203bc598f69c7d28e"
    );
    expect(msg.result.depositId).toBe(
      "0303030303030303030303030303030303030303030303030303030303030303"
    );
  });

  it("attestDepositoryDeposits - should return empty array when no events found", async () => {
    (httpRpc as jest.Mock).mockImplementation(() => ({
      getTransactionBlock: () => ({
        events: [],
      }),
    }));

    const service = new AttestationService();
    const deposits = await service.attestDepositoryDeposits({
      chainId: Object.values(await getChains())[0].id,
      transactionId: randomBase58(20),
    });
    expect(deposits).toEqual([]);
  });

  it("attestDepositoryDeposits - should handle transaction not found", async () => {
    (httpRpc as jest.Mock).mockImplementation(() => ({
      getTransactionBlock: () => null,
    }));

    const service = new AttestationService();
    const deposits = await service.attestDepositoryDeposits({
      chainId: Object.values(await getChains())[0].id,
      transactionId: randomBase58(20),
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
      useCoin: true 
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
      useCoin: true 
    });
  });
});

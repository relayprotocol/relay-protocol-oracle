import { describe, expect, it, jest } from "@jest/globals";
import {
  decodeWithdrawal,
  encodeWithdrawal,
  DepositoryWithdrawalStatus,
  getOrderId,
  Order,
  SolverFillStatus,
  SolverRefundStatus,
} from "@reservoir0x/relay-protocol-sdk";
import {
  Hex,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getVmTypeNativeCurrency } from "@reservoir0x/relay-protocol-sdk/src/utils";

import {
  Chain,
  getChains,
  getSdkChainsConfig,
} from "../../../../src/common/chains";
import { httpRpc } from "../../../../src/common/vm/tron-vm/rpc";
import { AttestationService } from "../../../../src/services/attestation";
import { ABI } from "../../../../src/services/attestation/vm/tron-vm";
import * as tronweb from "tronweb";

import { ONE_BILLION, randomHex, randomNumber } from "../../../common/utils";

const zeroAddress = getVmTypeNativeCurrency('tron-vm');

// Helper function to generate valid Tron address
const generateTronAddress = (): string => {
  const hexAddress = randomHex(20); // Generate 20-byte hex address
  return tronweb.utils.address.fromHex(`41${hexAddress.slice(2)}`);
};

const encodeAbiParameters = (
  _types: { name: string; type: string }[],
  _values: any[]
): string => {
  return tronweb.utils.abi.encodeParams(_types.map(c => c.type), _values.map((c, index) =>
    _types[index].type === 'address' ? tronweb.utils.address.toHex(c).replace(tronweb.utils.address.ADDRESS_PREFIX_REGEX, "0x") : c
  ));
};

const encodeEventTopics = (_options: {
  abi: any;
  eventName: string;
  args?: Record<string, any>;
}): string[] => {
  const iface = new tronweb.utils.ethersUtils.Interface(_options.abi);
  const event = iface.getEvent(_options.eventName);
  const topics = [event!.topicHash.slice(2)]; // Remove 0x prefix for Tron format
  
  // For indexed parameters, add them to topics (simplified for stub)
  if (_options.args) {
    const indexedParams = event!.inputs.filter((input: any) => input.indexed);
    for (const param of indexedParams) {
      if (_options.args[param.name]) {
        // Convert address to hex format for topics
        if (param.type === 'address') {
          const hexAddr = tronweb.utils.address.isAddress(_options.args[param.name])
            ? tronweb.utils.address.toHex(_options.args[param.name]).replace(tronweb.utils.address.ADDRESS_PREFIX_REGEX, '0x')
            : _options.args[param.name];
          topics.push(hexAddr.replace('0x', '').padStart(64, '0'));
        }
      }
    }
  }
  
  return topics;
};

const encodeFunctionData = (_options: {
  abi: any;
  functionName: string;
  args: any[];
}): string => {
  const iface = new tronweb.utils.ethersUtils.Interface(_options.abi);
  const functionData = iface.encodeFunctionData(_options.functionName,
    _options.args.map(c =>
      tronweb.utils.address.isAddress(c) ? tronweb.utils.address.toHex(c).replace(tronweb.utils.address.ADDRESS_PREFIX_REGEX, "0x") : c
    )
  );
  return functionData;
};

const testSolverPrivateKey =
  "0x1234567890123456789012345678901234567890123456789012345678901234";
const solverWallet = privateKeyToAccount(testSolverPrivateKey);

jest.mock("../../../../src/common/chains", () => {
  const chains: Record<string, Chain> = {
    tron: {
      id: "tron",
      vmType: "tron-vm",
      httpRpcUrl: "http://127.0.0.1:8090",
      depository: "TLyqzVGLV1srkB7dToTAEqgDSfPtXRJZYH",
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

jest.mock("../../../../src/common/vm/tron-vm/rpc", () => {
  return {
    httpRpc: jest.fn(),
  };
});

const generateTronTransactionReceipt = (
  transactionId: string,
  logs: any[]
): any => {
  return {
    id: transactionId,
    fee: randomNumber(10000000),
    blockNumber: randomNumber(10000),
    blockTimeStamp: Date.now(),
    contractResult: [""],
    contract_address: `41${randomHex(20).slice(2)}`,
    receipt: {
      energy_fee: randomNumber(1000000),
      energy_usage_total: randomNumber(100000),
      net_fee: randomNumber(10000),
      result: "SUCCESS",
    },
    log: logs,
    internal_transactions: [],
  };
};

const generateTronTransactionLog = ({
  // transactionId,
  // logIndex,
  address,
  data,
  topics,
}: {
  transactionId: string;
  logIndex: number;
  address: string;
  data: string;
  topics: string[];
}): any => {
  // Convert to Tron format - remove 0x prefix and ensure address is in hex format without 41 prefix
  return {
    address: tronweb.utils.address.isAddress(address) 
      ? tronweb.utils.address.toHex(address).slice(2) // Remove 41 prefix
      : address.replace("0x", ""),
    topics,
    data: data.replace("0x", ""),
  };
};

const generateTronTransferLog = ({
  transactionId,
  logIndex,
  from,
  to,
  token,
  amount,
}: {
  transactionId: string;
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

  return generateTronTransactionLog({
    transactionId,
    logIndex,
    address: token,
    data,
    topics: topics as string[],
  });
};

const generateTronNativeDepositLog = ({
  transactionId,
  logIndex,
  from,
  to,
  amount,
  id,
}: {
  transactionId: string;
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

  return generateTronTransactionLog({
    transactionId,
    logIndex,
    address: to,
    data,
    topics: topics as string[],
  });
};

const generateTronErc20DepositLog = ({
  transactionId,
  logIndex,
  from,
  to,
  token,
  amount,
  id,
}: {
  transactionId: string;
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

  return generateTronTransactionLog({
    transactionId,
    logIndex,
    address: to,
    data,
    topics: topics as string[],
  });
};

const generateTronSolverNativeTransferLog = ({
  transactionId,
  logIndex,
  from,
  to: solverContract,
  amount,
}: {
  transactionId: string;
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

  return generateTronTransactionLog({
    transactionId,
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
    version: "v1",
    salt: "0x1",
    solverChainId: "tron",
    solver: solverAddress,
    inputs: [
      {
        payment: {
          chainId: "tron",
          currency: inputCurrency,
          amount: paymentAmount,
          weight: "1",
        },
        refunds: [
          {
            chainId: "tron",
            recipient: refundRecipient,
            currency: inputCurrency,
            minimumAmount: paymentAmount,
            deadline: Math.floor(Date.now() / 1000) + 36000,
            extraData: encodeAbiParameters(
              [{ name: "fillContract", type: "address" }],
              [solverContractAddress]
            ),
          },
        ],
      },
    ],
    output: {
      chainId: "tron",
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
        [{ name: "fillContract", type: "address" }],
        [solverContractAddress]
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
  const depositorAddress = generateTronAddress();
  const tokenAddress = generateTronAddress();
  const paymentAmount = randomNumber(1e10).toString();
  const outputRecipient = generateTronAddress();
  const refundRecipient = generateTronAddress();
  const solverContractAddress = generateTronAddress();

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
function createTronNativeDepositTransaction(params: {
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

  const depositTransferLog = generateTronNativeDepositLog({
    transactionId: depositTxHash,
    logIndex: 0,
    from: depositorAddress,
    to: depositoryAddress,
    amount: paymentAmount,
    id: depositId ?? zeroHash,
  });

  return generateTronTransactionReceipt(depositTxHash, [depositTransferLog]);
}

// Create fill transaction logs
function createTronFillTransaction(params: {
  fillTxHash: string;
  outputRecipient: string;
  solverContractAddress: string;
  paymentAmount: string;
}) {
  const { fillTxHash, outputRecipient, solverContractAddress, paymentAmount } =
    params;

  const fillNativeTransferLog = generateTronSolverNativeTransferLog({
    transactionId: fillTxHash,
    logIndex: 0,
    from: outputRecipient,
    to: solverContractAddress,
    amount: paymentAmount,
  });

  return generateTronTransactionReceipt(fillTxHash, [fillNativeTransferLog]);
}

// Create refund transaction logs
function createTronRefundTransaction(params: {
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

  const refundNativeTransferLog = generateTronSolverNativeTransferLog({
    transactionId: refundTxHash,
    logIndex: 0,
    from: refundRecipient,
    to: solverContractAddress,
    amount: paymentAmount,
  });

  return generateTronTransactionReceipt(refundTxHash, [refundNativeTransferLog]);
}

function setupTronRpcMock(mockData: any) {
  (httpRpc as jest.Mock).mockImplementation(() => ({
    trx: {
      getTransaction: async (hash: string) => {
        const txData = mockData.transactions[hash];
        const data = txData.input.replace('0x', ''); // Remove 0x prefix for Tron format
        return {
          raw_data: {
            contract: [
              {
                type: "TriggerSmartContract",
                parameter: {
                  value: {
                    data,
                  },
                },
              },
            ],
          },
        };
      },
      getTransactionInfo: async (hash: string) => {
        const txData = mockData.transactions[hash];
        return txData.receipt;
      },
      getBlock: getTronBlockMock,
    },
    contract: () => ({
      at: async (_address: string) => ({
        methods: {
          callRequests: (_withdrawalId: string) => ({
            call: async () => mockData.isExecuted || false,
          }),
        },
      }),
    }),
  }));
}

const getTronBlockMock = async (data?: any) => {
  const now = Math.floor(Date.now());
  if (!data || data.blockTag === "latest") {
    return { 
      block_header: { 
        raw_data: { 
          timestamp: now + 61000 // 61 seconds to ensure finalization
        } 
      } 
    };
  } else {
    return { 
      block_header: { 
        raw_data: { 
          timestamp: now 
        } 
      } 
    };
  }
};

describe("TronVmAttestationService", () => {
  it("attestDepositoryDeposits - single Transfer event", async () => {
    const chains = Object.values(await getChains());

    const chain = chains[randomNumber(chains.length)];
    const transactionHash = randomHex(32);

    const from = generateTronAddress();
    const token = generateTronAddress();
    const amount = randomNumber(1e10).toString();

    const transferLog = generateTronTransferLog({
      transactionId: transactionHash,
      logIndex: 0,
      from,
      to: chain.depository!,
      token,
      amount,
    });
    const transactionReceipt = generateTronTransactionReceipt(transactionHash, [
      transferLog,
    ]);

    setupTronRpcMock({
      transactions: {
        [transactionHash]: {
          input: "0x",
          receipt: transactionReceipt,
        },
      },
    });

    const messages = await new AttestationService().attestDepositoryDeposits({
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

    const from = generateTronAddress();
    const token = generateTronAddress();
    const amount = randomNumber(1e10).toString();
    const id = randomHex(32);

    const transferLog = generateTronTransferLog({
      transactionId: transactionHash,
      logIndex: 0,
      from,
      to: chain.depository!,
      token,
      amount,
    });
    const transactionReceipt = generateTronTransactionReceipt(transactionHash, [
      transferLog,
    ]);

    setupTronRpcMock({
      transactions: {
        [transactionHash]: {
          input:
            encodeFunctionData({
              abi: ABI,
              functionName: "transfer",
              args: [chain.depository as Hex, BigInt(amount)],
            }) + id.slice(2),
          receipt: transactionReceipt,
        },
      },
    });

    const messages = await new AttestationService().attestDepositoryDeposits({
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

  it("attestDepositoryDeposits - Transfer event with consecutive RelayErc20Deposit event", async () => {
    const chains = Object.values(await getChains());

    const chain = chains[randomNumber(chains.length)];
    const transactionHash = randomHex(32);

    const from = generateTronAddress();
    const token = generateTronAddress();
    const amount = randomNumber(1e10).toString();
    const id = randomHex(32);

    const params = {
      transactionId: transactionHash,
      from,
      to: chain.depository!,
      token,
      amount,
    };

    const transferLog = generateTronTransferLog({ ...params, logIndex: 0 });
    const depositLog = generateTronErc20DepositLog({ ...params, id, logIndex: 1 });
    const transactionReceipt = generateTronTransactionReceipt(transactionHash, [
      transferLog,
      depositLog,
    ]);

    setupTronRpcMock({
      transactions: {
        [transactionHash]: {
          input: "0x",
          receipt: transactionReceipt,
        },
      },
    });

    const messages = await new AttestationService().attestDepositoryDeposits({
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

  it("attestDepositoryDeposits - Transfer event with RelayErc20Deposit event with zero id", async () => {
    const chains = Object.values(await getChains());

    const chain = chains[randomNumber(chains.length)];
    const transactionHash = randomHex(32);

    const from = generateTronAddress();
    const token = generateTronAddress();
    const amount = randomNumber(1e10).toString();

    const params = {
      transactionId: transactionHash,
      from,
      to: chain.depository!,
      token,
      amount,
    };

    const transferLog = generateTronTransferLog({ ...params, logIndex: 0 });
    const depositLog = generateTronErc20DepositLog({ ...params, id: zeroHash, logIndex: 1 });
    const transactionReceipt = generateTronTransactionReceipt(transactionHash, [
      transferLog,
      depositLog,
    ]);

    setupTronRpcMock({
      transactions: {
        [transactionHash]: {
          input: "0x",
          receipt: transactionReceipt,
        },
      },
    });

    const messages = await new AttestationService().attestDepositoryDeposits({
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
    expect(msg.result.depositId).toEqual(zeroHash); // Should be zeroHash since RelayErc20Deposit has zero id
  });

  it("attestDepositoryDeposits - multiple Transfer events (no calldata parsing)", async () => {
    const chains = Object.values(await getChains());

    const chain = chains[randomNumber(chains.length)];
    const transactionHash = randomHex(32);

    const from1 = generateTronAddress();
    const from2 = generateTronAddress();
    const token1 = generateTronAddress();
    const token2 = generateTronAddress();
    const amount1 = randomNumber(1e10).toString();
    const amount2 = randomNumber(1e10).toString();

    const transferLog1 = generateTronTransferLog({
      transactionId: transactionHash,
      logIndex: 0,
      from: from1,
      to: chain.depository!,
      token: token1,
      amount: amount1,
    });

    const transferLog2 = generateTronTransferLog({
      transactionId: transactionHash,
      logIndex: 1,
      from: from2,
      to: chain.depository!,
      token: token2,
      amount: amount2,
    });

    const transactionReceipt = generateTronTransactionReceipt(transactionHash, [
      transferLog1,
      transferLog2,
    ]);

    setupTronRpcMock({
      transactions: {
        [transactionHash]: {
          input: "0x",
          receipt: transactionReceipt,
        },
      },
    });

    const messages = await new AttestationService().attestDepositoryDeposits({
      chainId: chain.id,
      transactionId: transactionHash,
    });
    expect(messages.length === 2).toBeTruthy();

    // First message
    expect(messages[0].result.depositor).toEqual(from1);
    expect(messages[0].result.currency).toEqual(token1);
    expect(messages[0].result.amount).toEqual(amount1);
    expect(messages[0].result.depositId).toEqual(zeroHash); // Multiple Transfer events, no calldata parsing

    // Second message
    expect(messages[1].result.depositor).toEqual(from2);
    expect(messages[1].result.currency).toEqual(token2);
    expect(messages[1].result.amount).toEqual(amount2);
    expect(messages[1].result.depositId).toEqual(zeroHash); // Multiple Transfer events, no calldata parsing
  });

  it("attestDepositoryDeposits - Transfer event with non-matching RelayErc20Deposit event", async () => {
    const chains = Object.values(await getChains());

    const chain = chains[randomNumber(chains.length)];
    const transactionHash = randomHex(32);

    const from = generateTronAddress();
    const token = generateTronAddress();
    const differentToken = generateTronAddress(); // Different token for non-matching
    const amount = randomNumber(1e10).toString();
    const id = randomHex(32);

    const transferLog = generateTronTransferLog({
      transactionId: transactionHash,
      logIndex: 0,
      from,
      to: chain.depository!,
      token,
      amount,
    });

    // Create RelayErc20Deposit log with different token (non-matching)
    const depositLog = generateTronErc20DepositLog({
      transactionId: transactionHash,
      from,
      to: chain.depository!,
      token: differentToken, // Different token, should not match
      amount,
      id,
      logIndex: 1,
    });

    const transactionReceipt = generateTronTransactionReceipt(transactionHash, [
      transferLog,
      depositLog,
    ]);

    setupTronRpcMock({
      transactions: {
        [transactionHash]: {
          input: "0x",
          receipt: transactionReceipt,
        },
      },
    });

    const messages = await new AttestationService().attestDepositoryDeposits({
      chainId: chain.id,
      transactionId: transactionHash,
    });
    expect(messages.length === 1).toBeTruthy();

    const msg = messages[0];
    expect(msg.result.depositor).toEqual(from);
    expect(msg.result.currency).toEqual(token);
    expect(msg.result.amount).toEqual(amount);
    expect(msg.result.depositId).toEqual(zeroHash); // Should be zeroHash since RelayErc20Deposit doesn't match
  });

  it("attestDepositoryDeposits - single RelayNativeDeposit event", async () => {
    const chains = Object.values(await getChains());

    const chain = chains[randomNumber(chains.length)];
    const transactionHash = randomHex(32);

    const from = generateTronAddress();
    const amount = randomNumber(1e10).toString();
    const id = randomHex(32);

    const depositLog = generateTronNativeDepositLog({
      transactionId: transactionHash,
      logIndex: 0,
      from,
      to: chain.depository!,
      amount,
      id,
    });
    const transactionReceipt = generateTronTransactionReceipt(transactionHash, [
      depositLog,
    ]);

    setupTronRpcMock({
      transactions: {
        [transactionHash]: {
          input: "0x",
          receipt: transactionReceipt,
        },
      },
    });

    const messages = await new AttestationService().attestDepositoryDeposits({
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

  it("attestDepositoryWithdrawal - successful attestation", async () => {
    const chains = Object.values(await getChains());

    const chain = chains[randomNumber(chains.length)];
    
    const decodedWithdrawal: ReturnType<typeof decodeWithdrawal> = {
      vmType: "tron-vm",
      withdrawal: {
        calls: [
          {
            to: randomHex(20), // Use hex address instead of Tron address for encoding
            data: randomHex(64),
            value: randomNumber(ONE_BILLION).toString(),
            allowFailure: false,
          },
        ],
        nonce: randomNumber(ONE_BILLION).toString(),
        expiration: randomNumber(ONE_BILLION) * 1000, // Convert to milliseconds
      },
    };

    setupTronRpcMock({
      transactions: {},
      isExecuted: true,
    });

    const message = await new AttestationService().attestDepositoryWithdrawal({
      chainId: chain.id,
      withdrawal: encodeWithdrawal(decodedWithdrawal),
    });
    expect(message.result.depository).toEqual(chain.depository);
    expect(message.result.status).toEqual(DepositoryWithdrawalStatus.EXECUTED);
  });

  it("attestDepositoryWithdrawal - expired attestation", async () => {
    const chains = Object.values(await getChains());

    const chain = chains[randomNumber(chains.length)];
    const to = randomHex(20);  // Use hex address instead of Tron address for encoding
    const decodedWithdrawal: ReturnType<typeof decodeWithdrawal> = {
      vmType: "tron-vm",
      withdrawal: {
        calls: [
          {
            to,
            data: randomHex(64),
            value: randomNumber(ONE_BILLION).toString(),
            allowFailure: false,
          },
        ],
        nonce: randomNumber(ONE_BILLION).toString(),
        expiration: randomNumber(ONE_BILLION) * 1000, // Convert to milliseconds
      },
    };

    console.log('to', to)
    console.log('decodedWithdrawal', JSON.stringify(decodedWithdrawal, null, 2))

    setupTronRpcMock({
      transactions: {},
      isExecuted: false,
    });

    // Override the block mock to return a timestamp past expiration
    (httpRpc as jest.Mock).mockImplementation(() => ({
      trx: {
        getBlock: async () => ({
          block_header: { 
            raw_data: { 
              timestamp: decodedWithdrawal.withdrawal.expiration + 61000 // Past expiration + finalization time
            } 
          }
        }),
      },
      contract: () => ({
        at: async (_address: string) => ({
          methods: {
            callRequests: (_withdrawalId: string) => ({
              call: async () => false,
            }),
          },
        }),
      }),
    }));

    const message = await new AttestationService().attestDepositoryWithdrawal({
      chainId: chain.id,
      withdrawal: encodeWithdrawal(decodedWithdrawal),
    });
    expect(message.result.depository).toEqual(chain.depository);
    expect(message.result.status).toEqual(DepositoryWithdrawalStatus.EXPIRED);
  });

  it("attestDepositoryWithdrawal - pending attestation", async () => {
    const chains = Object.values(await getChains());

    const chain = chains[randomNumber(chains.length)];

    const decodedWithdrawal: ReturnType<typeof decodeWithdrawal> = {
      vmType: "tron-vm",
      withdrawal: {
        calls: [
          {
            to: randomHex(20), // Use hex address instead of Tron address for encoding
            data: randomHex(64),
            value: randomNumber(ONE_BILLION).toString(),
            allowFailure: false,
          },
        ],
        nonce: randomNumber(ONE_BILLION).toString(),
        expiration: randomNumber(ONE_BILLION) * 1000, // Convert to milliseconds
      },
    };

    setupTronRpcMock({
      transactions: {},
      isExecuted: false,
    });

    // Override the block mock to return a timestamp before expiration
    (httpRpc as jest.Mock).mockImplementation(() => ({
      trx: {
        getBlock: async () => ({
          block_header: { 
            raw_data: { 
              timestamp: decodedWithdrawal.withdrawal.expiration - 61000 // Before expiration but after finalization time
            } 
          }
        }),
      },
      contract: () => ({
        at: async (_address: string) => ({
          methods: {
            callRequests: (_withdrawalId: string) => ({
              call: async () => false,
            }),
          },
        }),
      }),
    }));

    const message = await new AttestationService().attestDepositoryWithdrawal({
      chainId: chain.id,
      withdrawal: encodeWithdrawal(decodedWithdrawal),
    });
    expect(message.result.depository).toEqual(chain.depository);
    expect(message.result.status).toEqual(DepositoryWithdrawalStatus.PENDING);
  });

  it("attestSolverFill - validates solver fill correctly", async () => {
    await testAttestTronSolverFill({});
  });

  it("attestSolverFill - fails with invalid order signature", async () => {
    await testAttestTronSolverFill({
      invalidSignature: true,
      expectError: "Invalid order signature",
    });
  });

  it("attestSolverFill - fails with non-unique onchain ids", async () => {
    await testAttestTronSolverFill({
      duplicateOnchainIds: true,
      expectError: "Input information contains non-unique onchain ids",
    });
  });

  it("attestSolverFill - fails with insufficient fill amount", async () => {
    await testAttestTronSolverFill({
      insufficientPayment: true,
      expectError: "Insufficient fill amount for order output payment",
    });
  });

  it("attestSolverFill - fails with expired output deadline", async () => {
    await testAttestTronSolverFill({
      expiredDeadline: true,
      expectError: "deadline",
    });
  });

  it("attestSolverFill - validates with TRC20 token payments", async () => {
    await testAttestTronSolverFill({
      useErc20Token: true,
    });
  });

  it("attestSolverRefund - validates solver refund correctly", async () => {
    await testAttestTronSolverRefund({});
  });

  it("attestSolverRefund - fails with invalid order signature", async () => {
    await testAttestTronSolverRefund({
      invalidSignature: true,
      expectError: "Invalid order signature",
    });
  });

  it("attestSolverRefund - validates with TRC20 token payments", async () => {
    await testAttestTronSolverRefund({
      useErc20Token: true,
    });
  });
});

/**
 * Create TRC20 transfer transaction logs and receipt
 */
const createTronErc20TransferTransaction = ({
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
}): any => {
  const transferLog = generateTronTransferLog({
    transactionId: transactionHash,
    logIndex: 0,  
    from,
    to,
    token: tokenAddress,
    amount,
  });
  const depositLog = depositId
    ? generateTronErc20DepositLog({
        transactionId: transactionHash,
        logIndex: 0,
        from,
        to,
        token: tokenAddress,
        amount,
        id: depositId,
      })
    : undefined;

  return generateTronTransactionReceipt(transactionHash, [
    transferLog,
    ...(depositLog ? [depositLog] : []),
  ]);
};

/**
 * Setup a unified test environment for both attestSolverFill and attestSolverRefund tests for Tron
 */
const setupTronTestEnvironment = async (
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
  const actionTxHash = randomHex(32);

  const paymentAmount = options.customPaymentAmount || testData.paymentAmount;
  const fillAmount = options.insufficientPayment
    ? ((BigInt(paymentAmount) * 50n) / 100n).toString()
    : paymentAmount;

  const testOrder = createTestOrder({
    paymentAmount,
    outputRecipient: testData.outputRecipient,
    refundRecipient: testData.refundRecipient,
    solverContractAddress: testData.solverContractAddress,
    solverAddress: solverWallet.address,
    inputCurrency: options.useErc20Token ? testData.tokenAddress : zeroAddress,
    outputCurrency: options.useErc20Token ? testData.tokenAddress : zeroAddress,
  });

  if (options.expiredDeadline) {
    testOrder.output.deadline = Math.floor(Date.now() / 1000) - 3600;
  }

  const orderHash = getOrderId(testOrder, await getSdkChainsConfig());

  let depositTxReceipt: any;
  if (options.useErc20Token) {
    depositTxReceipt = createTronErc20TransferTransaction({
      transactionHash: depositTxHash,
      from: testData.depositorAddress,
      to: testData.chain.depository,
      tokenAddress: testData.tokenAddress,
      amount: paymentAmount,
      depositId: orderHash,
    });
  } else {
    depositTxReceipt = createTronNativeDepositTransaction({
      depositTxHash,
      depositorAddress: testData.depositorAddress,
      depositoryAddress: testData.chain.depository,
      paymentAmount,
      depositId: orderHash,
    });
  }

  let actionTxReceipt: any;
  const isRefund = options.actionType === "refund";

  if (options.useErc20Token) {
    actionTxReceipt = createTronErc20TransferTransaction({
      transactionHash: actionTxHash,
      from: testData.solverContractAddress,
      to: isRefund ? testData.refundRecipient : testData.outputRecipient,
      tokenAddress: testData.tokenAddress,
      amount: fillAmount,
    });
  } else if (isRefund) {
    actionTxReceipt = createTronRefundTransaction({
      refundTxHash: actionTxHash,
      refundRecipient: testData.refundRecipient,
      solverContractAddress: testData.solverContractAddress,
      paymentAmount: fillAmount,
    });
  } else {
    actionTxReceipt = createTronFillTransaction({
      fillTxHash: actionTxHash,
      outputRecipient: testData.outputRecipient,
      solverContractAddress: testData.solverContractAddress,
      paymentAmount: fillAmount,
    });
  }

  setupTronRpcMock({
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
  });

  const signerWallet = options.invalidSignature
    ? privateKeyToAccount(randomHex(32) as Hex)
    : solverWallet;

  const orderSignature = await signerWallet.signMessage({
    message: { raw: orderHash },
  });

  const depositoryDeposits =
    await new AttestationService().attestDepositoryDeposits({
      chainId: testData.chain.id,
      transactionId: depositTxHash,
    });

  const inputs = options.duplicateOnchainIds
    ? [
        {
          transactionId: depositTxHash,
          onchainId: depositoryDeposits[0].result.onchainId,
          inputIndex: 0,
        },
        {
          transactionId: depositTxHash,
          onchainId: depositoryDeposits[0].result.onchainId,
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
 * Test attestSolverFill with various configurations for Tron
 */
const testAttestTronSolverFill = async (options: {
  useErc20Token?: boolean;
  invalidSignature?: boolean;
  expiredDeadline?: boolean;
  insufficientPayment?: boolean;
  duplicateOnchainIds?: boolean;
  customPaymentAmount?: string;
  expectError?: string;
}) => {
  const env = await setupTronTestEnvironment({ ...options, actionType: "fill" });

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
 * Test attestSolverRefund with various configurations for Tron
 */
const testAttestTronSolverRefund = async (options: {
  useErc20Token?: boolean;
  invalidSignature?: boolean;
  expiredDeadline?: boolean;
  insufficientPayment?: boolean;
  duplicateOnchainIds?: boolean;
  customPaymentAmount?: string;
  expectError?: string;
}) => {
  const env = await setupTronTestEnvironment({ ...options, actionType: "refund" });

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

    expect(solverRefundResult.result.status).toBe(
      SolverRefundStatus.SUCCESSFUL
    );
    expect(solverRefundResult.result.totalWeightedInputPaymentBpsDiff).toBe(
      "0"
    );
    return solverRefundResult;
  }
};

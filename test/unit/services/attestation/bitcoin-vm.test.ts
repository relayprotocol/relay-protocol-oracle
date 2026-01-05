import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import {
  DepositoryWithdrawalStatus,
  decodeWithdrawal,
  getDecodedWithdrawalId,
} from "@reservoir0x/relay-protocol-sdk";
import axios from "axios";
import * as bitcoin from "bitcoinjs-lib";
import { zeroHash } from "viem";

import { Chain } from "../../../../src/common/chains";
import { httpRpc } from "../../../../src/common/vm/bitcoin-vm/rpc";
import { AttestationService } from "../../../../src/services/attestation";

import { randomHex } from "../../../common/utils";
import { createMockWithdrawalAddressRequest } from "../../../common/withdrawals";

// Test Bitcoin addresses and private keys
const testDepositoryAddress = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
const testUserAddress =
  "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7";

jest.mock("../../../../src/common/chains", () => {
  const chains: Record<string, Chain> = {
    bitcoin: {
      id: "bitcoin",
      vmType: "bitcoin-vm",
      httpRpcUrl: "http://127.0.0.1:8332",
      depository: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
      hubChainId: "1",
      additionalData: {
        esploraCompatibleApiUrl: "http://localhost:3000",
      },
    },
  };
  return {
    HUB_VM_TYPE: "hub-vm",
    HUB_CHAIN_ID: 0n,
    getChains: async () => chains,
    getHubChains: async () => [],
    getChain: async (chainId: string) => chains[chainId],
    getChainVmType: async (chainId: string) => chains[chainId].vmType,
    getChainHubChainId: async (chainId: string) => chains[chainId].hubChainId,
    getSdkChainsConfig: () =>
      Object.fromEntries(
        Object.values(chains).map((chain) => [chain.id, chain.vmType])
      ),
  };
});
jest.mock("@reservoir0x/relay-protocol-sdk", () => {
  const original = jest.requireActual("@reservoir0x/relay-protocol-sdk");
  return {
    ...(original as any),
    decodeWithdrawal: jest.fn(),
    getDecodedWithdrawalAmount: jest.fn().mockReturnValue(1000),
    getDecodedWithdrawalId: jest.fn().mockReturnValue("0x1234567890"),
  };
});
jest.mock("axios", () => {
  const mockAxios = {
    get: jest.fn().mockImplementation(() => Promise.resolve({ data: {} })),
  };
  return mockAxios;
});
jest.mock("../../../../src/common/vm/bitcoin-vm/rpc", () => {
  return {
    httpRpc: jest.fn(),
  };
});

// Generate Bitcoin transaction
const generateBitcoinTransaction = (
  txid: string,
  options: {
    confirmations?: number;
    blockhash?: string;
    vout?: Array<{
      value: number;
      n: number;
      scriptPubKey: {
        asm: string;
        desc: string;
        hex: string;
        type: string;
        address?: string;
      };
    }>;
    vin?: Array<{
      txid: string;
      vout: number;
      scriptSig?: {
        asm: string;
        hex: string;
      };
      txinwitness?: string[];
      sequence: number;
    }>;
  } = {}
) => {
  const defaultBlockhash = randomHex(32);

  return {
    txid,
    hash: txid,
    version: 2,
    size: 225,
    vsize: 225,
    weight: 900,
    locktime: 0,
    vin: options.vin || [
      {
        txid: Buffer.from(randomHex(32).replace(/^0x/, ""), "hex")
          .reverse()
          .toString("hex"),
        vout: 0,
        scriptSig: {
          asm: "3045022100f4d17785319488c32c4e3d339c5e8f317c94c4978e4b0641fb9cd4eacc89b0e802203c58f8c3ec9072a5e33a4c12b5641b3c5bca14047b7e1b6969d1d3c6e6210c1b[ALL] 0304c01563d46e38264283b99bb352b46e69bf132431f102d4bd9a9d8dab075e7f",
          hex: "483045022100f4d17785319488c32c4e3d339c5e8f317c94c4978e4b0641fb9cd4eacc89b0e802203c58f8c3ec9072a5e33a4c12b5641b3c5bca14047b7e1b6969d1d3c6e6210c1b01210304c01563d46e38264283b99bb352b46e69bf132431f102d4bd9a9d8dab075e7f",
        },
        sequence: 4294967295,
      },
    ],
    vout: options.vout || [
      {
        value: 100000000, // 1 BTC in satoshis
        n: 0,
        scriptPubKey: {
          asm: "0 751e76e8199196d454941c45d1b3a323f1433bd6",
          desc: "addr(tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx)",
          hex: "0014751e76e8199196d454941c45d1b3a323f1433bd6",
          type: "witness_v0_keyhash",
          address: testDepositoryAddress,
        },
      },
    ],
    blockhash: options.blockhash || defaultBlockhash,
    confirmations:
      options.confirmations !== undefined ? options.confirmations : 3,
    blocktime: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
  };
};

// Generate Bitcoin block
const generateBitcoinBlock = (
  blockhash: string,
  options: {
    confirmations?: number;
    time?: number;
    tx?: string[];
  } = {}
) => {
  return {
    hash: blockhash,
    confirmations:
      options.confirmations !== undefined ? options.confirmations : 3,
    size: 1000,
    strippedsize: 800,
    weight: 4000,
    height: 2000000,
    version: 536870912,
    versionHex: "20000000",
    merkleroot: randomHex(32),
    tx: options.tx || [randomHex(32)],
    time:
      options.time !== undefined
        ? options.time
        : Math.floor(Date.now() / 1000) - 3600,
    mediantime: Math.floor(Date.now() / 1000) - 3700,
    nonce: 3604508752,
    bits: "1d00ffff",
    difficulty: 1,
    chainwork:
      "0000000000000000000000000000000000000000000000000000000000100010",
    nTx: 1,
    previousblockhash: randomHex(32),
  };
};

// Generate transaction output with OP_RETURN
const generateOpReturnOutput = (
  data: string,
  n: number = 1
): {
  value: number;
  n: number;
  scriptPubKey: {
    asm: string;
    desc: string;
    hex: string;
    type: string;
  };
} => {
  const buffer = Buffer.from(data);
  const hex = buffer.toString("hex");

  // Choose OP_RETURN format based on data length
  let scriptHex;
  if (buffer.length <= 75) {
    scriptHex = `6a${buffer.length.toString(16).padStart(2, "0")}${hex}`;
  } else {
    scriptHex = `6a4c${buffer.length.toString(16).padStart(2, "0")}${hex}`;
  }

  return {
    value: 0,
    n,
    scriptPubKey: {
      asm: `OP_RETURN ${hex}`,
      desc: `raw(${scriptHex})`,
      hex: scriptHex,
      type: "nulldata",
    },
  };
};

// Setup RPC mock
const setupRpcMock = (mockData: any) => {
  (httpRpc as jest.Mock).mockImplementation(() => {
    return Promise.resolve({
      ...mockData,
    });
  });
};

// Create a Bitcoin transaction with deposit ID
const createDepositTransaction = (
  txid: string,
  depositId: string = zeroHash,
  amount: number = 100000000, // 1 BTC in satoshis
  confirmations: number = 3
) => {
  const opReturnOutput = generateOpReturnOutput(depositId);

  return generateBitcoinTransaction(txid, {
    confirmations,
    vout: [
      {
        value: amount,
        n: 0,
        scriptPubKey: {
          asm: "0 751e76e8199196d454941c45d1b3a323f1433bd6",
          desc: `addr(${testDepositoryAddress})`,
          hex: "0014751e76e8199196d454941c45d1b3a323f1433bd6",
          type: "witness_v0_keyhash",
          address: testDepositoryAddress,
        },
      },
      opReturnOutput,
    ],
    vin: [
      {
        txid: randomHex(32),
        vout: 0,
        scriptSig: {
          asm: "3045022100f4d17785319488c32c4e3d339c5e8f317c94c4978e4b0641fb9cd4eacc89b0e802203c58f8c3ec9072a5e33a4c12b5641b3c5bca14047b7e1b6969d1d3c6e6210c1b[ALL] 0304c01563d46e38264283b99bb352b46e69bf132431f102d4bd9a9d8dab075e7f",
          hex: "483045022100f4d17785319488c32c4e3d339c5e8f317c94c4978e4b0641fb9cd4eacc89b0e802203c58f8c3ec9072a5e33a4c12b5641b3c5bca14047b7e1b6969d1d3c6e6210c1b01210304c01563d46e38264283b99bb352b46e69bf132431f102d4bd9a9d8dab075e7f",
        },
        sequence: 4294967295,
      },
    ],
  });
};

// Create an input transaction (for getting input address)
const createInputTransaction = (
  txid: string,
  address: string = testUserAddress
) => {
  return generateBitcoinTransaction(txid, {
    vout: [
      {
        value: 150000000, // 1.5 BTC in satoshis
        n: 0,
        scriptPubKey: {
          asm: "0 1863143c14c5166804bd19203356da136c985678",
          desc: `addr(${address})`,
          hex: "00141863143c14c5166804bd19203356da136c985678",
          type: "witness_v0_keyhash",
          address,
        },
      },
    ],
  });
};

describe("BitcoinVmAttestor", () => {
  describe("getDepositoryDepositMessages", () => {
    it("should correctly parse Bitcoin deposit transaction", async () => {
      // Prepare test data
      const transactionId = randomHex(32);
      const depositId = randomHex(32);
      const depositTx = createDepositTransaction(transactionId, depositId);
      const inputTxid = depositTx.vin[0].txid;
      const inputTx = createInputTransaction(inputTxid);

      // Setup RPC mock
      setupRpcMock({
        getTransaction: async (txid: string) => {
          if (txid === transactionId) {
            return depositTx;
          } else if (txid === inputTxid) {
            return inputTx;
          }
          return null;
        },
        getBlock: async () => generateBitcoinBlock(depositTx.blockhash),
      });

      // Execute test
      const { messages } =
        await new AttestationService().attestDepositoryDeposits({
          chainId: "bitcoin",
          transactionId,
        });

      // Verify results
      expect(messages).toHaveLength(1);
      expect(messages[0].result.depositId).toBe(depositId);
      expect(messages[0].result.depositor).toBe(testUserAddress);
      expect(messages[0].result.amount).toBe("100000000");
      expect(messages[0].result.currency).toBe(
        "bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8"
      );
    });

    it("should throw error when transaction confirmations are insufficient", async () => {
      // Prepare test data
      const transactionId = randomHex(32);
      const depositTx = createDepositTransaction(
        transactionId,
        zeroHash,
        100000000,
        1
      ); // Only 1 confirmation

      // Setup RPC mock
      setupRpcMock({
        getTransaction: jest.fn().mockReturnValue(depositTx),
        getBlock: jest
          .fn()
          .mockReturnValue(generateBitcoinBlock(depositTx.blockhash)),
      });

      // Execute test and verify error
      await expect(
        new AttestationService().attestDepositoryDeposits({
          chainId: "bitcoin",
          transactionId,
        })
      ).rejects.toThrow(`Transaction ${transactionId} is not finalized`);
    });
  });

  describe("getDepositoryWithdrawalMessage", () => {
    const withdrawalAddressRequest = createMockWithdrawalAddressRequest({
      depositoryChainSlug: "bitcoin",
      depositoryAddress: testDepositoryAddress,
    });

    beforeEach(() => {
      // Reset all mocks before each test
      jest.clearAllMocks();
    });

    // Helper function to setup withdrawal test with mocked dependencies
    const setupWithdrawalTest = (
      options: {
        isSpent?: boolean;
        txMatches?: boolean;
        multipleSpendingTxs?: boolean;
        noAllocatorUtxos?: boolean;
      } = {}
    ) => {
      const {
        isSpent = false,
        txMatches = true,
        multipleSpendingTxs = false,
        noAllocatorUtxos = false,
      } = options;

      // Mock withdrawal data
      const withdrawalHex = "0x1234";
      const decodedWithdrawal = {
        vmType: "bitcoin-vm",
        withdrawal: {
          psbt: "02000000000101abcdef",
        },
      };

      // Generate a random spending transaction ID
      const spendingTxId = randomHex(32);
      const secondSpendingTxId = randomHex(32);

      // Setup decodeWithdrawal mock
      (decodeWithdrawal as jest.Mock).mockImplementation(
        () => decodedWithdrawal
      );
      (getDecodedWithdrawalId as jest.Mock).mockImplementation(
        () => "0x1234567890"
      );

      // Setup bitcoinjs-lib mock for PSBT with partial signatures
      const mockPsbt = {
        data: {
          inputs: [
            {
              witnessUtxo: {
                script: noAllocatorUtxos
                  ? Buffer.from(
                      "00140000000000000000000000000000000000000000",
                      "hex"
                    ) // Different script
                  : Buffer.from(
                      "00147751e76e8199196d454941c45d1b3a323f1433bd6",
                      "hex"
                    ),
              },
              partialSig: [
                {
                  pubkey: Buffer.from(
                    "0304c01563d46e38264283b99bb352b46e69bf132431f102d4bd9a9d8dab075e7f",
                    "hex"
                  ),
                  signature: Buffer.from(
                    "3045022100f4d17785319488c32c4e3d339c5e8f317c94c4978e4b0641fb9cd4eacc89b0e802203c58f8c3ec9072a5e33a4c12b5641b3c5bca14047b7e1b6969d1d3c6e6210c1b01",
                    "hex"
                  ),
                },
              ],
            },
            // Add a second input for multiple spending tx test
            {
              witnessUtxo: {
                script: noAllocatorUtxos
                  ? Buffer.from(
                      "00140000000000000000000000000000000000000000",
                      "hex"
                    ) // Different script
                  : Buffer.from(
                      "00147751e76e8199196d454941c45d1b3a323f1433bd6",
                      "hex"
                    ),
              },
              partialSig: [
                {
                  pubkey: Buffer.from(
                    "0304c01563d46e38264283b99bb352b46e69bf132431f102d4bd9a9d8dab075e7f",
                    "hex"
                  ),
                  signature: Buffer.from(
                    "3045022100f4d17785319488c32c4e3d339c5e8f317c94c4978e4b0641fb9cd4eacc89b0e802203c58f8c3ec9072a5e33a4c12b5641b3c5bca14047b7e1b6969d1d3c6e6210c1b01",
                    "hex"
                  ),
                },
              ],
            },
          ],
        },
        txInputs: [
          { hash: Buffer.from("abcdef1234567890", "hex"), index: 0 },
          { hash: Buffer.from("1234567890abcdef", "hex"), index: 1 },
        ],
      };

      // Mock bitcoinjs-lib functions
      jest
        .spyOn(bitcoin.Psbt, "fromHex")
        .mockImplementation(() => mockPsbt as any);
      jest
        .spyOn(bitcoin.address, "toOutputScript")
        .mockImplementation(() =>
          Buffer.from("00147751e76e8199196d454941c45d1b3a323f1433bd6", "hex")
        );

      // Mock Esplora API response
      if (multipleSpendingTxs) {
        // For multiple spending transactions case, we need to return different txids
        // for different inputs to simulate multiple transactions spending the same UTXO
        (axios.get as jest.Mock).mockImplementation((url: unknown) => {
          // Extract txid and vout from URL to determine which input we're checking
          const match = (url as string).match(
            /\/tx\/([a-f0-9]+)\/outspend\/(\d+)$/
          );
          if (match) {
            const [, , vout] = match;
            // Return different spending txids based on which input we're checking
            return Promise.resolve({
              data: {
                spent: true,
                txid: vout === "0" ? spendingTxId : secondSpendingTxId,
                status: { confirmed: true },
              },
            });
          }
          return Promise.resolve({ data: {} });
        });
      } else {
        // Normal case - all inputs spent by same tx or not spent
        (axios.get as jest.Mock).mockImplementation(() => {
          return Promise.resolve({
            data: {
              spent: isSpent,
              txid: isSpent ? spendingTxId : undefined,
              status: isSpent ? { confirmed: true } : undefined,
            },
          });
        });
      }

      // Create mock transaction with witness data
      const mockTx = {
        ins: [
          {
            witness: txMatches
              ? [
                  // Match the signature and pubkey from PSBT
                  Buffer.from(
                    "3045022100f4d17785319488c32c4e3d339c5e8f317c94c4978e4b0641fb9cd4eacc89b0e802203c58f8c3ec9072a5e33a4c12b5641b3c5bca14047b7e1b6969d1d3c6e6210c1b01",
                    "hex"
                  ),
                  Buffer.from(
                    "0304c01563d46e38264283b99bb352b46e69bf132431f102d4bd9a9d8dab075e7f",
                    "hex"
                  ),
                ]
              : [
                  // Different signature for non-matching case
                  Buffer.from(
                    "3045022100aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa02203c58f8c3ec9072a5e33a4c12b5641b3c5bca14047b7e1b6969d1d3c6e6210c1b01",
                    "hex"
                  ),
                  Buffer.from(
                    "0304c01563d46e38264283b99bb352b46e69bf132431f102d4bd9a9d8dab075e7f",
                    "hex"
                  ),
                ],
          },
          // Add a second input for multiple spending tx test
          {
            witness: txMatches
              ? [
                  // Match the signature and pubkey from PSBT
                  Buffer.from(
                    "3045022100f4d17785319488c32c4e3d339c5e8f317c94c4978e4b0641fb9cd4eacc89b0e802203c58f8c3ec9072a5e33a4c12b5641b3c5bca14047b7e1b6969d1d3c6e6210c1b01",
                    "hex"
                  ),
                  Buffer.from(
                    "0304c01563d46e38264283b99bb352b46e69bf132431f102d4bd9a9d8dab075e7f",
                    "hex"
                  ),
                ]
              : [
                  // Different signature for non-matching case
                  Buffer.from(
                    "3045022100aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa02203c58f8c3ec9072a5e33a4c12b5641b3c5bca14047b7e1b6969d1d3c6e6210c1b01",
                    "hex"
                  ),
                  Buffer.from(
                    "0304c01563d46e38264283b99bb352b46e69bf132431f102d4bd9a9d8dab075e7f",
                    "hex"
                  ),
                ],
          },
        ],
      };

      // Mock Transaction.fromHex
      jest
        .spyOn(bitcoin.Transaction, "fromHex")
        .mockImplementation(() => mockTx as any);

      // Mock Bitcoin RPC response
      const mockRpcFunctions = {
        getRawTransaction: jest.fn().mockImplementation(() => {
          return Promise.resolve("02000000000101abcdef");
        }),
      };

      (httpRpc as jest.Mock).mockImplementation(() => {
        return Promise.resolve(mockRpcFunctions);
      });

      return { withdrawalHex, spendingTxId };
    };

    it("should return PENDING status when no transaction spends the PSBT inputs", async () => {
      // Setup test with default configuration (unspent input)
      const { withdrawalHex } = setupWithdrawalTest();

      // Execute test
      const { message } =
        await new AttestationService().attestDepositoryWithdrawal({
          chainId: "bitcoin",
          withdrawal: withdrawalHex,
          withdrawalAddressRequest,
        });

      // Verify results
      expect(message.result.withdrawalId).toBe("0x1234567890");
      expect(message.result.depository).toBe(testDepositoryAddress);
      expect(message.result.status).toBe(DepositoryWithdrawalStatus.PENDING);
    });

    it("should return EXECUTED status when PSBT matches the spending transaction", async () => {
      // Setup test with spent input and matching transaction
      const { withdrawalHex } = setupWithdrawalTest({
        isSpent: true,
        txMatches: true,
      });

      // Execute test
      const { message } =
        await new AttestationService().attestDepositoryWithdrawal({
          chainId: "bitcoin",
          withdrawal: withdrawalHex,
          withdrawalAddressRequest,
        });

      // Verify results
      expect(message.result.withdrawalId).toBe("0x1234567890");
      expect(message.result.depository).toBe(testDepositoryAddress);
      expect(message.result.status).toBe(DepositoryWithdrawalStatus.EXECUTED);
    });

    it("should return EXPIRED status when PSBT does not match the spending transaction", async () => {
      // Setup test with spent input but non-matching transaction
      const { withdrawalHex } = setupWithdrawalTest({
        isSpent: true,
        txMatches: false,
      });

      // Execute test
      const { message } =
        await new AttestationService().attestDepositoryWithdrawal({
          chainId: "bitcoin",
          withdrawal: withdrawalHex,
          withdrawalAddressRequest,
        });

      // Verify results
      expect(message.result.withdrawalId).toBe("0x1234567890");
      expect(message.result.depository).toBe(testDepositoryAddress);
      expect(message.result.status).toBe(DepositoryWithdrawalStatus.EXPIRED);
    });

    it("should return EXPIRED status when multiple transactions spend the PSBT inputs", async () => {
      // Setup test with multiple spending transactions
      const { withdrawalHex } = setupWithdrawalTest({
        multipleSpendingTxs: true,
      });

      // Execute test
      const { message } =
        await new AttestationService().attestDepositoryWithdrawal({
          chainId: "bitcoin",
          withdrawal: withdrawalHex,
          withdrawalAddressRequest,
        });

      // Verify results
      expect(message.result.withdrawalId).toBe("0x1234567890");
      expect(message.result.depository).toBe(testDepositoryAddress);
      expect(message.result.status).toBe(DepositoryWithdrawalStatus.EXPIRED);
    });

    it("should throw error when no allocator UTXOs are detected", async () => {
      // Setup test with no allocator UTXOs
      const { withdrawalHex } = setupWithdrawalTest({
        noAllocatorUtxos: true,
      });

      // Execute test and expect error
      await expect(
        new AttestationService().attestDepositoryWithdrawal({
          chainId: "bitcoin",
          withdrawal: withdrawalHex,
          withdrawalAddressRequest,
        })
      ).rejects.toThrow(
        "No allocator UTXOs detected as part of the withdrawal request"
      );
    });
  });
});

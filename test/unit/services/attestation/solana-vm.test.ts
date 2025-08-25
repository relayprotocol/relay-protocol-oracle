import { describe, expect, it, jest } from "@jest/globals";

import { randomBase58 } from "../../../common/utils";
import { Chain, getChains } from "../../../../src/common/chains";
import { httpRpc } from "../../../../src/common/vm/solana-vm/rpc";
import { AttestationService } from "../../../../src/services/attestation";

jest.mock("../../../../src/common/chains", () => {
  const chains: Record<string, Chain> = {
    solana: {
      id: "solana",
      vmType: "solana-vm",
      httpRpcUrl: "http://127.0.0.1:8545",
      depository: "FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u",
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
    const messages = await service.attestDepositoryDeposits({
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
    const messages = await service.attestDepositoryDeposits({
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
});

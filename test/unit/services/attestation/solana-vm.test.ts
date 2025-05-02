import { describe, expect, it, jest } from "@jest/globals";

import { randomBase58 } from "../../../common/utils";
import { Chain, getChains } from "../../../../src/common/chains";
import { httpRpc } from "../../../../src/common/vm/solana-vm/rpc";
import { AttestationService } from "../../../../src/services/attestation";

jest.mock("../../../../src/common/chains", () => {
  const chains: Record<string, Chain> = {
    solana: {
      id: "solana",
      name: "Test",
      vmType: "solana-vm",
      httpRpcUrl: "http://127.0.0.1:8545",
      escrow: "FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u",
    },
  };
  return {
    getChains: async () => chains,
    getChain: async (chainId: number) => chains[chainId],
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
});

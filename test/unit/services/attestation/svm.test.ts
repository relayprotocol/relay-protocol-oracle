import { describe, expect, it, jest } from "@jest/globals";
import { httpRpc } from "../../../../src/common/vm/svm/rpc";
import { SolanaAttestationService } from "../../../../src/services/attestation/svm";
import { EscrowDepositMessage } from "../../../../src/services/attestation/types";

jest.mock("../../../../src/common/chains", () => {
    const chains: Record<number, any> = {
        1: {
            id: 1,
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
jest.mock("../../../../src/common/vm/svm/rpc", () => {
    return {
        httpRpc: jest.fn(),
    };
});

describe("SolanaAttestationService", () => {

    it("should attest transfer executed event", async () => {
        // const mockEvent = {
        //   name: "TransferExecutedEvent",
        //   data: {
        //     request: {
        //       recipient: new PublicKey("9swxehyJkNTDpqX6vX79tH2AWiJjYJnkLDtyhgrBUsjm"),
        //       token: null,
        //       amount: BigInt("100000000"),
        //       nonce: BigInt("0196099e7fe4"),
        //       expiration: 1234567890
        //     },
        //     executor: new PublicKey("Da1mJyh2iqq7287Bzwv61bEc691zPAXWMBvpLZx8w8uA"),
        //     id: new PublicKey("AFwk1wX1efTqiV37seaAzJAKHjjUDZxeKnfBU5p6wmbJ")
        //   }
        // };

        const logs = [
            "Program FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u invoke [1]",
            "Program log: Instruction: ExecuteTransfer",
            "Program data: XAqyuBIseHyD6q3CsL4+q/8vpriI7Znwv82QTXEgc/7YdToVNNU48AAA4fUFAAAAAOR/ngmWAQAAQxXyZwAAAAC6wUYM1quIijgngodEMdwvpDcpi1C1upEEr7d/coYFjYmNNdNGyIwr7uBGBuJEKw0NK1Ht/OvBhp4dbV4JCJaV",
        ];

        (httpRpc as jest.Mock).mockImplementation(() => ({
            getParsedTransaction: () => ({
                meta: {
                    logMessages: logs
                }
            })
        }));

        const service = new SolanaAttestationService();
        const messages = await service.attestEscrowWithdrawals(1, "test-tx-id");

        expect(messages.length).toBe(1);
        expect(messages[0].kind).toBe("escrow-withdrawal");
        expect(messages[0].output.currency).toBe("11111111111111111111111111111111");
        expect(messages[0].output.amount).toBe("100000000");
        expect(messages[0].output.id).toBe("AFwk1wX1efTqiV37seaAzJAKHjjUDZxeKnfBU5p6wmbJ");
    });

    it("should attest deposit event - SPL", async () => {

        const logs = [
            'Program FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u invoke [1]',
            'Program log: Instruction: DepositToken',
            'Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL invoke [2]',
            'Program log: Create',
            'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [3]',
            'Program log: Instruction: GetAccountDataSize',
            'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 1595 of 171961 compute units',
            'Program return: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA pQAAAAAAAAA=',
            'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success',
            'Program 11111111111111111111111111111111 invoke [3]',
            'Program 11111111111111111111111111111111 success',
            'Program log: Initialize the associated token account',
            'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [3]',
            'Program log: Instruction: InitializeImmutableOwner',
            'Program log: Please upgrade to SPL Token 2022 for immutable owner support',
            'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 1405 of 165348 compute units',
            'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success',
            'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [3]',
            'Program log: Instruction: InitializeAccount3',
            'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 4214 of 161464 compute units',
            'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success',
            'Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL consumed 20490 of 177436 compute units',
            'Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL success',
            'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]',
            'Program log: Instruction: Transfer',
            'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 4645 of 154583 compute units',
            'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success',
            'Program data: ePg9Ux+Oa5BKhcPIo5YCxfVvqfPz933GfySoNJT1XBm7C56dKEjbtgECj6a+uZgbJKIbAmd7tEbJyCWUKmAw0BsVRHOkEgXc4gDKmjsAAAAAAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=',
            'Program FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u consumed 50781 of 200000 compute units',
            'Program FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u success'
        ];

        (httpRpc as jest.Mock).mockImplementation(() => ({
            getParsedTransaction: () => ({
                meta: {
                    logMessages: logs
                }
            })
        }));

        const service = new SolanaAttestationService();
        const messages = await service.attestEscrowDeposits(1, "test-tx-id");
        const msg = messages[0] as EscrowDepositMessage;

        expect(messages.length).toBe(1);
        expect(msg.kind).toBe("escrow-deposit");
        expect(msg.output.currency).toBe("AzrxfjSRgePBiRyHoV4mdUX2LVTxwPR9E1Crr9mZVeH");
        expect(msg.output.amount).toBe("1000000000");
        expect(msg.output.depositor).toBe("61uUNRFVyDQsyne2cHzEmjA76UYpfsRKi2EaDoYH64Rs");
        expect(msg.output.id).toBe("0202020202020202020202020202020202020202020202020202020202020202");
    });

    it("should attest deposit event - native", async () => {

        const logs = [
            'Program FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u invoke [1]',
            'Program log: Instruction: DepositSol',
            'Program 11111111111111111111111111111111 invoke [2]',
            'Program 11111111111111111111111111111111 success',
            'Program data: ePg9Ux+Oa5B41ZyI3pX01JFl6AV6P2HoW3/Z+7eGs9orfK3r4gNo5QAAypo7AAAAAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB',
            'Program FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u consumed 11114 of 200000 compute units',
            'Program FcdAmYWSixzyEGHaPQmDWXzyVFbiKEU2f4MuJfkLKH3u success'
        ];

        (httpRpc as jest.Mock).mockImplementation(() => ({
            getParsedTransaction: () => ({
                meta: {
                    logMessages: logs
                }
            })
        }));

        const service = new SolanaAttestationService();
        const messages = await service.attestEscrowDeposits(1, "test-tx-id");
        const msg = messages[0] as EscrowDepositMessage;

        expect(messages.length).toBe(1);
        expect(msg.kind).toBe("escrow-deposit");
        expect(msg.output.currency).toBe("11111111111111111111111111111111");
        expect(msg.output.amount).toBe("1000000000");
        expect(msg.output.depositor).toBe("98gqt9w7M9gZCEnN42HpbeRzaMst89fxdqXBFhuM4Njv");
        expect(msg.output.id).toBe("0101010101010101010101010101010101010101010101010101010101010101");
    });

    it("should return empty array when no events found", async () => {
        (httpRpc as jest.Mock).mockImplementation(() => ({
            getParsedTransaction: () => ({
                meta: {
                    logMessages: []
                }
            })
        }));

        const service = new SolanaAttestationService();
        const deposits = await service.attestEscrowDeposits(1, "test-tx-id");
        const withdrawals = await service.attestEscrowWithdrawals(1, "test-tx-id");

        expect(deposits).toEqual([]);
        expect(withdrawals).toEqual([]);
    });

    it("should handle transaction not found", async () => {
        (httpRpc as jest.Mock).mockImplementation(() => ({
            getParsedTransaction: () => null
        }));

        const service = new SolanaAttestationService();
        const deposits = await service.attestEscrowDeposits(1, "test-tx-id");
        const withdrawals = await service.attestEscrowWithdrawals(1, "test-tx-id");

        expect(deposits).toEqual([]);
        expect(withdrawals).toEqual([]);
    });
});
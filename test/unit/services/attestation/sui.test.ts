import { describe, expect, it, jest } from "@jest/globals";
import { httpRpc } from "../../../../src/common/vm/suivm/rpc";
import { SuiAttestationService } from "../../../../src/services/attestation/suivm";
import { EscrowDepositMessage, EscrowWithdrawalMessage } from "../../../../src/services/attestation/types";

jest.mock("../../../../src/common/chains", () => {
    const chains: Record<number, any> = {
        1: {
            id: 1, 
            name: "Test",
            vmType: "sui-vm",
            httpRpcUrl: "http://127.0.0.1:9000",
            escrow: "0x9d2a84411e00bcc5f39fd137521106b2a968ee7998db999203bc598f69c7d28e",
        },
    };
    return {
        getChains: () => chains,
        getChain: (chainId: number) => chains[chainId],
    };
});

jest.mock("../../../../src/common/vm/suivm/rpc", () => {
    return {
        httpRpc: jest.fn(),
    };
});

describe("SuiAttestationService", () => {

    it("should attest transfer executed event", async () => {
        const events = [{
            id: {
                txDigest: "4M4GNixunQrkiDTRwVHnZupLEaKRE3RmiEGzMmFEa5to",
                eventSeq: "0"
            },
            packageId: "0x9d2a84411e00bcc5f39fd137521106b2a968ee7998db999203bc598f69c7d28e",
            transactionModule: "escrow",
            sender: "0x70d8697b66fbc6c63130ec17a3a1c0e12030070851a9a3a717574a767a03c48c",
            type: "0x9d2a84411e00bcc5f39fd137521106b2a968ee7998db999203bc598f69c7d28e::escrow::TransferExecutedEvent",
            parsedJson: {
                amount: "500",
                coin_type: {
                    name: "0000000000000000000000000000000000000000000000000000000000000002::sui::SUI"
                },
                recipient: "0xd63b34130788d21d3cbd39a6cb55c8b8d27fe37c055c321be490fd2146209c1c",
                request_hash: [
                    55, 221, 125, 236, 188, 178, 203, 208, 73, 22, 229, 185,
                    136, 10, 233, 192, 106, 220, 175, 35, 146, 118, 180, 148,
                    188, 232, 235, 144, 94, 11, 175, 52
                ]
            }
        }];

        (httpRpc as jest.Mock).mockImplementation(() => ({
            getTransactionBlock: () => ({
                events
            })
        }));

        const service = new SuiAttestationService();
        const messages = await service.attestEscrowWithdrawals(1, "test-tx-id");
        const msg = messages[0] as EscrowWithdrawalMessage;

        expect(messages.length).toBe(1);
        expect(msg.kind).toBe("escrow-withdrawal");
        expect(msg.output.currency).toBe("0000000000000000000000000000000000000000000000000000000000000002::sui::SUI");
        expect(msg.output.amount).toBe("500");
        expect(msg.output.id).toBe("37dd7decbcb2cbd04916e5b9880ae9c06adcaf239276b494bce8eb905e0baf34");
    });

    it("should attest deposit event", async () => {
        const events = [{
            id: {
                txDigest: "5JAY6Fq3qyp1CVy91nxhuhtEBeyx15Wdv42wzpLbmqRw",
                eventSeq: "0"
            },
            packageId: "0x9d2a84411e00bcc5f39fd137521106b2a968ee7998db999203bc598f69c7d28e", 
            transactionModule: "escrow",
            sender: "0x70d8697b66fbc6c63130ec17a3a1c0e12030070851a9a3a717574a767a03c48c",
            type: "0x9d2a84411e00bcc5f39fd137521106b2a968ee7998db999203bc598f69c7d28e::escrow::DepositEvent",
            parsedJson: {
                amount: "1000",
                coin_type: {
                    name: "ad1dd9d79dc28f7e7fb00ba4adca54e9847aa6ea959330f4249319f18f16300d::usdc::USDC"
                },
                deposit_id: "0x444dc5b0f731cf61ee5872e21189da034158935f00b511e630f5d34e4563e7ac",
                from: "0x70d8697b66fbc6c63130ec17a3a1c0e12030070851a9a3a717574a767a03c48c"
            }
        }];

        (httpRpc as jest.Mock).mockImplementation(() => ({
            getTransactionBlock: () => ({
                events
            })
        }));

        const service = new SuiAttestationService();
        const messages = await service.attestEscrowDeposits(1, "test-tx-id");
        const msg = messages[0] as EscrowDepositMessage;

        expect(messages.length).toBe(1);
        expect(msg.kind).toBe("escrow-deposit");
        expect(msg.output.currency).toBe("ad1dd9d79dc28f7e7fb00ba4adca54e9847aa6ea959330f4249319f18f16300d::usdc::USDC");
        expect(msg.output.amount).toBe("1000");
        expect(msg.output.depositor).toBe("0x70d8697b66fbc6c63130ec17a3a1c0e12030070851a9a3a717574a767a03c48c");
        expect(msg.output.id).toBe("0x444dc5b0f731cf61ee5872e21189da034158935f00b511e630f5d34e4563e7ac");
    });

    it("should return empty array when no events found", async () => {
        (httpRpc as jest.Mock).mockImplementation(() => ({
            getTransactionBlock: () => ({
                events: []
            })
        }));

        const service = new SuiAttestationService();
        const deposits = await service.attestEscrowDeposits(1, "test-tx-id");
        const withdrawals = await service.attestEscrowWithdrawals(1, "test-tx-id");

        expect(deposits).toEqual([]);
        expect(withdrawals).toEqual([]);
    });

    it("should handle transaction not found", async () => {
        (httpRpc as jest.Mock).mockImplementation(() => ({
            getTransactionBlock: () => null
        }));

        const service = new SuiAttestationService();
        const deposits = await service.attestEscrowDeposits(1, "test-tx-id");
        const withdrawals = await service.attestEscrowWithdrawals(1, "test-tx-id");

        expect(deposits).toEqual([]);
        expect(withdrawals).toEqual([]);
    });
});
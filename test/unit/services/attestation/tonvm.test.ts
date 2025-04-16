import { describe, expect, it, jest } from "@jest/globals";
import { httpRpc } from "../../../../src/common/vm/tonvm/rpc";
import { SuiAttestationService } from "../../../../src/services/attestation/tonvm";
import { EscrowDepositMessage, EscrowWithdrawalMessage } from "../../../../src/services/attestation/types";
import { loadTransaction, Cell, Address } from "@ton/core"

jest.mock("../../../../src/common/chains", () => {
    const chains: Record<number, any> = {
        1: {
            id: 1, 
            name: "Test",
            vmType: "ton-vm",
            httpRpcUrl: "http://127.0.0.1:9000",
            escrow: "EQCPCNJo1kfIutVC_VDrov-3TfbwreJDMUtfRA7NxGlrZntT",
        },
    };
    return {
        getChains: () => chains,
        getChain: (chainId: number) => chains[chainId],
    };
});

jest.mock("../../../../src/common/vm/tonvm/rpc", () => {
    return {
        httpRpc: jest.fn(),
    };
});

describe("TonAttestationService", () => {

    it("should attest transfer executed event", async () => {
        const mockTx = loadTransaction(
            Cell.fromBase64('te6cckECDwEAA1UAA7VzEbHDDhubxfSsQra+0sO5x4RaTmbxhfyoz7i1N7+s7vAAAAAAEh6sATyHV2yityT5JvExIyt7Lbkkabfe8Iyd0lIigh2vCuPQAAAAAA9CQAZ/iZ/AAFRqKEJoAQsMAgHgAgYByWgA0Ysl743u6R45APS3dYe9Ynu3ViWfeVffFh+QDpbH/ScADEbHDDhubxfSsQra+0sO5x4RaTmbxhfyoz7i1N7+s7vQdzWUAAYXDiIAAAAAAiVRAs/xM/hoxXJhAAAAAAAAAABAAwECAQQB/QAAAAAAAAABZ/ioDACAFyMX5Xl7cgzYsZFHeKEQRQU1peDbO6gb4W0d2ydc+58wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIdzWUAIBfXhAIF9eEAQFAIArXXHy+lNilvNcdvUydtokfpNS1LTXz15RAMfQBSGlBAf4JTXcwotKOaCFoeVTnDamobZCieA7/r8Mq4uRu0EDAgHdBwkBASAIALFIAGI2OGHDc3i+lYhW19pYdzjwi0nM3jC/lRn3Fqb39Z3fAC5GL8ry9uQZsWMijvFCIIoKa0vBtndQN8LaO7ZOufc+UO5rKAAGCCNaAAAAAAJD1YLP8TP4QAEBIAoA8eABiNjhhw3N4vpWIVtfaWHc48ItJzN4wv5UZ9xam9/Wd3gAAAAAAkPVhM/xM/gAuQ9c/QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABDuaygBRcWYMDLhVri6mdJd0zXV897tFhvgdGx7GM/m0Eb94sIAgnI6GreB5iJs2EOo67elM8TjN/7vJSGMxnAHTlU2wbTMVK3x/qF7/KqawlrCgdzg3iSjG5f+Esh47IRlNgZd4ZvgAhUECQdzWUAYaSPYEQ0OAJ5F2Yw9CQAAAAAAAAAAAPgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAG/JhhqATCCNTAAAAAAABAAAAAAABTgFrVcUnZ8m33P0yo1AV+dtfFxTZIZAcwCbLKE5LG1IQJA0PHpxAD4=').beginParse()
        );

        const mockCurrency = Address.parse('EQCPCNJo1kfIutVC_VDrov-3TfbwreJDMUtfRA7NxGlrZntT');
        (httpRpc as jest.Mock).mockImplementation(() => ({
            getTransaction: () => mockTx,
            provider: () => {
                return {
                    open: () => {
                        return {
                            getData: () => ({
                                jettonMaster: mockCurrency
                            })
                        };
                    }
                }
            }
        }));

        const service = new SuiAttestationService();
        const messages = await service.attestEscrowWithdrawals(1, ["EQBoxZL3xvd0jxyAelu6w96xPdurEs-8q--LD8gHS2P-k3h3", "1", "1"].join("::"));
        const msg = messages[0] as EscrowWithdrawalMessage;

        expect(messages.length).toBe(1);
        expect(msg.kind).toBe("escrow-withdrawal");
        expect(msg.output.currency).toBe("EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c");
        expect(msg.output.amount).toBe("1000000000");
        expect(msg.output.id).toBe("36837698756550845923548951145281232355085456059853636759437290613526864296112");
    });

    it("should attest deposit event - native", async () => {
        const mockTx = loadTransaction(
            Cell.fromBase64('te6cckECCgEAAkEAA7V0LjyuCsbc0eqGDFL88VrYtWcvAbKORh8vyuTo7YBzgqAAAAAAEh6sDskEJq30EG5DxKDsnPVOt/4bFiRdH0+mXQ/pMiUImOTwAAAAAA9CQAZ/YD3AADRl+ngIAQYHAgHgAgMA22gA0Ysl743u6R45APS3dYe9Ynu3ViWfeVffFh+QDpbH/ScAELjyuCsbc0eqGDFL88VrYtWcvAbKORh8vyuTo7YBzgqUXSHboAAGCCNaAAAAAAIlUQLP7Ae4fKOImgAAAAAAAAAAAAAAAAAAADbAAQHfBAFd4AIXHlcFY25o9UMGKX54rWxas5eA2UcjD5flcnR2wDnBUAAAAAACQ9WCz+wHuMAFAKsCIh5pJQAQuPK4KxtzR6oYMUvzxWti1Zy8Bso5GHy/K5OjtgHOCpRdIdugAgA0Ysl743u6R45APS3dYe9Ynu3ViWfeVffFh+QDpbH/SYAAAAAAAAA2wACCchEuJJvVlb1rJhpfqoKx2KfOGXN/f7yCNU88nxrnuvqfHQ7i4Ny8D04E/ACJQ04YCV6eOFzn3Dss3ZB+u7Z3aocCFwQJRdIdugAYZJ6eEQgJAJ5C9Ow9CQAAAAAAAAAAAGcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAG/JhW9oTCt7QAAAAAAAAgAAAAAAA56/J/3e+obXYDksTPHu8iW5ir2nAcFdSeRKWjV8Y6xuQJAg1IcXwO8=').beginParse()
        );

        const mockCurrency = Address.parse('EQCPCNJo1kfIutVC_VDrov-3TfbwreJDMUtfRA7NxGlrZntT');
        (httpRpc as jest.Mock).mockImplementation(() => ({
            getTransaction: () => mockTx,
            provider: () => {
                return {
                    open: () => {
                        return {
                            getData: () => ({
                                jettonMaster: mockCurrency
                            })
                        };
                    }
                }
            }
        }));

        const service = new SuiAttestationService();
        const messages = await service.attestEscrowDeposits(1, ["EQBoxZL3xvd0jxyAelu6w96xPdurEs-8q--LD8gHS2P-k3h3", "1", "1"].join("::"));
        const msg = messages[0] as EscrowDepositMessage;

        expect(messages.length).toBe(1);
        expect(msg.kind).toBe("escrow-deposit");
        expect(msg.output.currency).toBe("EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c");
        expect(msg.output.amount).toBe("100000000000");
        expect(msg.output.depositor).toBe("EQBoxZL3xvd0jxyAelu6w96xPdurEs-8q--LD8gHS2P-k3h3");
        expect(msg.output.id).toBe("109");
    });

    it("should attest deposit event - jetton", async () => {
        const mockTx = loadTransaction(
            Cell.fromBase64(
                'te6cckECDAEAAmUAA7VySHGCivmBxMf4ixS9coZhA4n0+Hrb0cCrASqj86KUVyAAAAAAFAb0BokHZqpXXirmVPFuJBXR3Hg7gWcChQWEhwgVXZ3v7yVAAAAAAA9CQAZ/YD3QADRliGgIAQgJAgHgAgUBr0gArUtaacjYqPT75uK7ZXIpnojCY81LS58t4O7unAsqD+cACSHGCivmBxMf4ixS9coZhA4n0+Hrb0cCrASqj86KUVyOYloABg16CAAAAAACYloCz+wHusADAWJzYtCcAAAAAAAAAAA5iWgIANGLJe+N7ukeOQD0t3WHvWJ7t1Yln3lX3xYfkA6Wx/0nBAAQAAAAAAAAAGwBAd8GAV3gASQ4wUV8wOJj/EWKXrlDMIHE+nw9bejgVYCVUfnRSiuQAAAAAAKA3oLP7Ae6wAcApwIiHmknABWpa005GxUen3zcV2yuRTPRGEx5qWlz5bwd3dOBZUH8zmJaAgA0Ysl743u6R45APS3dYe9Ynu3ViWfeVffFh+QDpbH/SYAAAAAAAAA2QACCcpPFm9kQeg+SexmkM+STjEQ3B859kpk2h6Q7l8y+BDvGoQs6VpBfCjpElMur3dfTrqgJfGsDRC2xt+Z9SKVOk04CEwwI5iWgGGQvrhEKCwCcQq3phqAAAAAAAAAAAHoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAG/JhWLoTCsXQAAAAAAAAgAAAAAAAk8E2jhiM/lMW1vL/8T6HpfrkQyu1RX0RvSUbqIaRz4oQJAgVAcUAfk='
            ).beginParse()
        );
        const mockCurrency = Address.parse('EQCPCNJo1kfIutVC_VDrov-3TfbwreJDMUtfRA7NxGlrZntT');
        (httpRpc as jest.Mock).mockImplementation(() => ({
            getTransaction: () => mockTx,
            provider: () => {
                return {
                    open: () => {
                        return {
                            getData: () => ({
                                jettonMaster: mockCurrency
                            })
                        };
                    }
                }
            }
        }));

        const service = new SuiAttestationService();
        const messages = await service.attestEscrowDeposits(1, ["EQBoxZL3xvd0jxyAelu6w96xPdurEs-8q--LD8gHS2P-k3h3", "1", "1"].join("::"));
        const msg = messages[0] as EscrowDepositMessage;

        expect(messages.length).toBe(1);
        expect(msg.kind).toBe("escrow-deposit");
        expect(msg.output.currency).toBe(mockCurrency.toString());
        expect(msg.output.amount).toBe("10000000");
        expect(msg.output.depositor).toBe("EQBoxZL3xvd0jxyAelu6w96xPdurEs-8q--LD8gHS2P-k3h3");
        expect(msg.output.id).toBe("108");
    });
});
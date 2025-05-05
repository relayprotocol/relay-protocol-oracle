import { describe, expect, it, jest } from "@jest/globals";
import { loadTransaction, Cell, Address } from "@ton/core";

import { Chain, getChains } from "../../../../src/common/chains";
import { httpRpc } from "../../../../src/common/vm/ton-vm/rpc";
import { AttestationService } from "../../../../src/services/attestation";

jest.mock("../../../../src/common/chains", () => {
  const chains: Record<string, Chain> = {
    ton: {
      id: "ton",
      vmType: "ton-vm",
      httpRpcUrl: "http://127.0.0.1:9000",
      escrow: "EQCPCNJo1kfIutVC_VDrov-3TfbwreJDMUtfRA7NxGlrZntT",
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
jest.mock("../../../../src/common/vm/ton-vm/rpc", () => {
  return {
    httpRpc: jest.fn(),
  };
});

describe("TonAttestationService", () => {
  it("attestEscrowDeposits - should attest native deposit event", async () => {
    const mockTx = loadTransaction(
      Cell.fromBase64(
        "te6cckECCgEAAkEAA7V0LjyuCsbc0eqGDFL88VrYtWcvAbKORh8vyuTo7YBzgqAAAAAAEh6sDskEJq30EG5DxKDsnPVOt/4bFiRdH0+mXQ/pMiUImOTwAAAAAA9CQAZ/YD3AADRl+ngIAQYHAgHgAgMA22gA0Ysl743u6R45APS3dYe9Ynu3ViWfeVffFh+QDpbH/ScAELjyuCsbc0eqGDFL88VrYtWcvAbKORh8vyuTo7YBzgqUXSHboAAGCCNaAAAAAAIlUQLP7Ae4fKOImgAAAAAAAAAAAAAAAAAAADbAAQHfBAFd4AIXHlcFY25o9UMGKX54rWxas5eA2UcjD5flcnR2wDnBUAAAAAACQ9WCz+wHuMAFAKsCIh5pJQAQuPK4KxtzR6oYMUvzxWti1Zy8Bso5GHy/K5OjtgHOCpRdIdugAgA0Ysl743u6R45APS3dYe9Ynu3ViWfeVffFh+QDpbH/SYAAAAAAAAA2wACCchEuJJvVlb1rJhpfqoKx2KfOGXN/f7yCNU88nxrnuvqfHQ7i4Ny8D04E/ACJQ04YCV6eOFzn3Dss3ZB+u7Z3aocCFwQJRdIdugAYZJ6eEQgJAJ5C9Ow9CQAAAAAAAAAAAGcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAG/JhW9oTCt7QAAAAAAAAgAAAAAAA56/J/3e+obXYDksTPHu8iW5ir2nAcFdSeRKWjV8Y6xuQJAg1IcXwO8="
      ).beginParse()
    );

    const mockCurrency = Address.parse(
      "EQCPCNJo1kfIutVC_VDrov-3TfbwreJDMUtfRA7NxGlrZntT"
    );
    (httpRpc as jest.Mock).mockImplementation(() => ({
      getTransaction: () => mockTx,
      provider: () => {
        return {
          open: () => {
            return {
              getData: () => ({
                jettonMaster: mockCurrency,
              }),
            };
          },
        };
      },
    }));

    const service = new AttestationService();
    const messages = await service.attestEscrowDeposits({
      chainId: Object.values(await getChains())[0].id,
      transactionId: [
        "EQBoxZL3xvd0jxyAelu6w96xPdurEs-8q--LD8gHS2P-k3h3",
        "1",
        "1",
      ].join("::"),
    });
    const msg = messages[0];

    expect(messages.length).toBe(1);
    expect(msg.result.currency).toBe(
      "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c"
    );
    expect(msg.result.amount).toBe("100000000000");
    expect(msg.result.depositor).toBe(
      "EQBoxZL3xvd0jxyAelu6w96xPdurEs-8q--LD8gHS2P-k3h3"
    );
    expect(msg.result.escrow).toBe(
      "EQCPCNJo1kfIutVC_VDrov-3TfbwreJDMUtfRA7NxGlrZntT"
    );
    expect(msg.result.depositId).toBe("109");
  });

  it("attestEscrowDeposits - should attest jetton deposit event", async () => {
    const mockTx = loadTransaction(
      Cell.fromBase64(
        "te6cckECDAEAAmUAA7VySHGCivmBxMf4ixS9coZhA4n0+Hrb0cCrASqj86KUVyAAAAAAFAb0BokHZqpXXirmVPFuJBXR3Hg7gWcChQWEhwgVXZ3v7yVAAAAAAA9CQAZ/YD3QADRliGgIAQgJAgHgAgUBr0gArUtaacjYqPT75uK7ZXIpnojCY81LS58t4O7unAsqD+cACSHGCivmBxMf4ixS9coZhA4n0+Hrb0cCrASqj86KUVyOYloABg16CAAAAAACYloCz+wHusADAWJzYtCcAAAAAAAAAAA5iWgIANGLJe+N7ukeOQD0t3WHvWJ7t1Yln3lX3xYfkA6Wx/0nBAAQAAAAAAAAAGwBAd8GAV3gASQ4wUV8wOJj/EWKXrlDMIHE+nw9bejgVYCVUfnRSiuQAAAAAAKA3oLP7Ae6wAcApwIiHmknABWpa005GxUen3zcV2yuRTPRGEx5qWlz5bwd3dOBZUH8zmJaAgA0Ysl743u6R45APS3dYe9Ynu3ViWfeVffFh+QDpbH/SYAAAAAAAAA2QACCcpPFm9kQeg+SexmkM+STjEQ3B859kpk2h6Q7l8y+BDvGoQs6VpBfCjpElMur3dfTrqgJfGsDRC2xt+Z9SKVOk04CEwwI5iWgGGQvrhEKCwCcQq3phqAAAAAAAAAAAHoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAG/JhWLoTCsXQAAAAAAAAgAAAAAAAk8E2jhiM/lMW1vL/8T6HpfrkQyu1RX0RvSUbqIaRz4oQJAgVAcUAfk="
      ).beginParse()
    );
    const mockCurrency = Address.parse(
      "EQCPCNJo1kfIutVC_VDrov-3TfbwreJDMUtfRA7NxGlrZntT"
    );
    (httpRpc as jest.Mock).mockImplementation(() => ({
      getTransaction: () => mockTx,
      provider: () => {
        return {
          open: () => {
            return {
              getData: () => ({
                jettonMaster: mockCurrency,
              }),
            };
          },
        };
      },
    }));

    const service = new AttestationService();
    const messages = await service.attestEscrowDeposits({
      chainId: Object.values(await getChains())[0].id,
      transactionId: [
        "EQBoxZL3xvd0jxyAelu6w96xPdurEs-8q--LD8gHS2P-k3h3",
        "1",
        "1",
      ].join("::"),
    });
    const msg = messages[0];

    expect(messages.length).toBe(1);
    expect(msg.result.currency).toBe(mockCurrency.toString());
    expect(msg.result.amount).toBe("10000000");
    expect(msg.result.depositor).toBe(
      "EQBoxZL3xvd0jxyAelu6w96xPdurEs-8q--LD8gHS2P-k3h3"
    );
    expect(msg.result.escrow).toBe(
      "EQCPCNJo1kfIutVC_VDrov-3TfbwreJDMUtfRA7NxGlrZntT"
    );
    expect(msg.result.depositId).toBe("108");
  });
});

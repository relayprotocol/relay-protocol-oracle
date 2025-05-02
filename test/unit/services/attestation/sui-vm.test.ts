import { describe, expect, it, jest } from "@jest/globals";

import { randomBase58 } from "../../../common/utils";
import { Chain, getChains } from "../../../../src/common/chains";
import { httpRpc } from "../../../../src/common/vm/sui-vm/rpc";
import { AttestationService } from "../../../../src/services/attestation";

jest.mock("../../../../src/common/chains", () => {
  const chains: Record<string, Chain> = {
    sui: {
      id: "sui",
      name: "Test",
      vmType: "sui-vm",
      httpRpcUrl: "http://127.0.0.1:9000",
      escrow:
        "0x9d2a84411e00bcc5f39fd137521106b2a968ee7998db999203bc598f69c7d28e",
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

describe("SuiAttestationService", () => {
  it("attestEscrowDeposits - should attest deposit event", async () => {
    const events = [
      {
        id: {
          txDigest: "2p3QBA3rXV6VSQBsu8SmtEnaWSXAu7P9p5xEPaDDz6sE",
          eventSeq: "0",
        },
        packageId:
          "0x0b50c9a37ec3e171b115455e73158c6aa2d7d079bf2915720f022457dc987bd4",
        transactionModule: "escrow",
        sender:
          "0x5f7f85e64cb90f4fad427c119cfcfe916397e6f559e052e686df05fe561f9f80",
        type: "0x0b50c9a37ec3e171b115455e73158c6aa2d7d079bf2915720f022457dc987bd4::escrow::DepositEvent",
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
    const messages = await service.attestEscrowDeposits({
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
    expect(msg.result.depositId).toBe(
      "0303030303030303030303030303030303030303030303030303030303030303"
    );
  });

  it("attestEscrowDeposits - should return empty array when no events found", async () => {
    (httpRpc as jest.Mock).mockImplementation(() => ({
      getTransactionBlock: () => ({
        events: [],
      }),
    }));

    const service = new AttestationService();
    const deposits = await service.attestEscrowDeposits({
      chainId: Object.values(await getChains())[0].id,
      transactionId: randomBase58(20),
    });
    expect(deposits).toEqual([]);
  });

  it("attestEscrowDeposits - should handle transaction not found", async () => {
    (httpRpc as jest.Mock).mockImplementation(() => ({
      getTransactionBlock: () => null,
    }));

    const service = new AttestationService();
    const deposits = await service.attestEscrowDeposits({
      chainId: Object.values(await getChains())[0].id,
      transactionId: randomBase58(20),
    });
    expect(deposits).toEqual([]);
  });
});

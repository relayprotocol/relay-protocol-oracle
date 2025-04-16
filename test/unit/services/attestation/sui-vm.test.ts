import { describe, expect, it, jest } from "@jest/globals";

import { randomBase58 } from "../../../common/utils";
import { getChains } from "../../../../src/common/chains";
import { httpRpc } from "../../../../src/common/vm/sui-vm/rpc";
import { SuiAttestationService } from "../../../../src/services/attestation/sui-vm";
import {
  EscrowDepositMessage,
  EscrowWithdrawalMessage,
} from "../../../../src/services/attestation/messages";

jest.mock("../../../../src/common/chains", () => {
  const chains: Record<number, any> = {
    1: {
      id: 1,
      name: "Test",
      vmType: "sui-vm",
      httpRpcUrl: "http://127.0.0.1:9000",
      escrow:
        "0x9d2a84411e00bcc5f39fd137521106b2a968ee7998db999203bc598f69c7d28e",
    },
  };
  return {
    getChains: () => chains,
    getChain: (chainId: number) => chains[chainId],
  };
});
jest.mock("../../../../src/common/vm/sui-vm/rpc", () => {
  return {
    httpRpc: jest.fn(),
  };
});

describe("SuiAttestationService", () => {
  it("attestEscrowWithdrawals - should attest transfer executed event", async () => {
    const events = [
      {
        id: {
          txDigest: "4M4GNixunQrkiDTRwVHnZupLEaKRE3RmiEGzMmFEa5to",
          eventSeq: "0",
        },
        packageId:
          "0x9d2a84411e00bcc5f39fd137521106b2a968ee7998db999203bc598f69c7d28e",
        transactionModule: "escrow",
        sender:
          "0x70d8697b66fbc6c63130ec17a3a1c0e12030070851a9a3a717574a767a03c48c",
        type: "0x9d2a84411e00bcc5f39fd137521106b2a968ee7998db999203bc598f69c7d28e::escrow::TransferExecutedEvent",
        parsedJson: {
          amount: "500",
          coin_type: {
            name: "0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
          },
          recipient:
            "0xd63b34130788d21d3cbd39a6cb55c8b8d27fe37c055c321be490fd2146209c1c",
          request_hash: [
            55, 221, 125, 236, 188, 178, 203, 208, 73, 22, 229, 185, 136, 10,
            233, 192, 106, 220, 175, 35, 146, 118, 180, 148, 188, 232, 235, 144,
            94, 11, 175, 52,
          ],
        },
      },
    ];

    (httpRpc as jest.Mock).mockImplementation(() => ({
      getTransactionBlock: () => ({
        events,
      }),
    }));

    const service = new SuiAttestationService();
    const messages = await service.attestEscrowWithdrawals({
      chainId: Object.values(await getChains())[0].id,
      transactionId: randomBase58(20),
    });
    const msg = messages[0] as EscrowWithdrawalMessage;

    expect(messages.length).toBe(1);
    expect(msg.kind).toBe("escrow-withdrawal");
    expect(msg.result.currency).toBe(
      "0000000000000000000000000000000000000000000000000000000000000002::sui::SUI"
    );
    expect(msg.result.amount).toBe("500");
    expect(msg.result.id).toBe(
      "37dd7decbcb2cbd04916e5b9880ae9c06adcaf239276b494bce8eb905e0baf34"
    );
  });

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

    const service = new SuiAttestationService();
    const messages = await service.attestEscrowDeposits({
      chainId: Object.values(await getChains())[0].id,
      transactionId: randomBase58(20),
    });
    const msg = messages[0] as EscrowDepositMessage;

    expect(messages.length).toBe(1);
    expect(msg.kind).toBe("escrow-deposit");
    expect(msg.result.currency).toBe(
      "0000000000000000000000000000000000000000000000000000000000000002::sui::SUI"
    );
    expect(msg.result.amount).toBe("3000");
    expect(msg.result.depositor).toBe(
      "0x5f7f85e64cb90f4fad427c119cfcfe916397e6f559e052e686df05fe561f9f80"
    );
    expect(msg.result.id).toBe(
      "0303030303030303030303030303030303030303030303030303030303030303"
    );
  });

  it("attestEscrowDeposits - should return empty array when no events found", async () => {
    (httpRpc as jest.Mock).mockImplementation(() => ({
      getTransactionBlock: () => ({
        events: [],
      }),
    }));

    const service = new SuiAttestationService();
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

    const service = new SuiAttestationService();
    const deposits = await service.attestEscrowDeposits({
      chainId: Object.values(await getChains())[0].id,
      transactionId: randomBase58(20),
    });
    expect(deposits).toEqual([]);
  });
});

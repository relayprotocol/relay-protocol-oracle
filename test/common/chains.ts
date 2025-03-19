import { Chain, ChainVmType } from "../../src/common/chains";

export const chains: Chain[] = [
  {
    id: 1000,
    name: "Test",
    vmType: ChainVmType.EthereumVM,
    httpRpcUrl: "http://127.0.0.1:8545",
    metadata: {
      escrow: "0x0000000000000000000000000000000000001000",
    },
  },
];

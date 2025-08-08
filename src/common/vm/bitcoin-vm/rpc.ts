import axios from "axios";
import { parseUnits } from "viem";

import { getChain } from "../../chains";

class RpcConnection {
  private rpcUrl: string;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
  }

  private async rpc(method: string, params: any[]) {
    const { data } = await axios.post(
      `${this.rpcUrl}`,
      {
        jsonrpc: "1.0",
        id: 1,
        method,
        params,
      },
      {
        validateStatus: () => true,
      }
    );
    if (data.error || data.result?.errors) {
      throw new Error(JSON.stringify(data.error || data.result?.errors));
    }

    return data.result;
  }

  async getBlock(blockHash: string): Promise<{
    tx: string[];
    hash: string;
    confirmations: number;
    size: number;
    strippedsize: number;
    weight: number;
    height: number;
    version: number;
    versionHex: string;
    merkleroot: string;
    time: number;
    mediantime: number;
    nonce: number;
    bits: string;
    difficulty: number;
    chainwork: string;
    nTx: number;
    previousblockhash: string;
  }> {
    return this.rpc("getblock", [blockHash]);
  }

  async getRawTransaction(txid: string): Promise<{
    txid: string;
    hash: string;
    version: number;
    size: number;
    vsize: number;
    weight: number;
    locktime: number;
    vin: {
      txid: string;
      vout: number;
      scriptSig: {
        asm: string;
        hex: string;
      };
      txinwitness: string[];
      sequence: number;
    }[];
    vout: {
      value: number;
      n: number;
      scriptPubKey: {
        asm: string;
        desc: string;
        hex: string;
        type: string;
        address?: string;
      };
    }[];
    blocktime?: number;
    confirmations?: number;
    blockhash: string;
  }> {
    const result = await this.rpc("getrawtransaction", [txid, true]);
    return {
      txid: result.txid,
      hash: result.txid,
      version: result.version,
      size: result.size,
      vsize: result.vsize,
      weight: result.weight,
      locktime: result.locktime,
      vin: result.vin.map((input: any) => ({
        txid: input.txid,
        vout: input.vout,
        scriptSig: input.scriptSig
          ? {
              asm: input.scriptSig.asm,
              hex: input.scriptSig.hex,
            }
          : undefined,
        sequence: input.sequence,
        txinwitness: input.txinwitness,
      })),
      vout: result.vout.map((output: any) => ({
        // Convert from btc to sat
        value: Number(
          parseUnits(Number(output.value).toFixed(8).toString(), 8)
        ),
        n: output.n,
        scriptPubKey: {
          asm: output.scriptPubKey.asm,
          hex: output.scriptPubKey.hex,
          type: output.scriptPubKey.type,
          address: output.scriptPubKey.address,
        },
      })),
      blockhash: result.blockhash,
      confirmations: result.confirmations,
      blocktime: result.blocktime,
    };
  }
}

export const httpRpc = async (chainId: string) => {
  const chain = await getChain(chainId);
  return new RpcConnection(chain.httpRpcUrl);
};

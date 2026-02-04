import axios from "axios";
import * as bitcoin from "bitcoinjs-lib";
import { zeroHash } from "viem";

import {
  DecodedBitcoinVmWithdrawal,
  decodeWithdrawal,
  DepositoryWithdrawalMessage,
  DepositoryWithdrawalStatus,
  getDecodedWithdrawalId,
  getVmTypeNativeCurrency,
} from "@relay-protocol/settlement-sdk";

import { getDeterministicId } from "../utils";
import { EnhancedDepositoryDepositMessage, VmAttestor } from "../../vm/types";
import { getChain } from "../../../../common/chains";
import { externalError, internalError } from "../../../../common/error";
import { getTrackingId, logRpcUsage } from "../../../../common/rpc-usage";
import { httpRpc } from "../../../../common/vm/bitcoin-vm/rpc";

const VM_TYPE = "bitcoin-vm";

export class BitcoinVmAttestor extends VmAttestor {
  public async getDepositoryDepositMessages(
    chainId: string,
    transactionId: string,
  ): Promise<EnhancedDepositoryDepositMessage[]> {
    const trackingId = getTrackingId();

    const rpc = await httpRpc(chainId);

    // Get transaction details
    await logRpcUsage(chainId, "getTransaction", trackingId);
    const transaction = await rpc.getTransaction(transactionId);
    if (!transaction) {
      throw externalError(`Missing transaction ${transactionId}`);
    }

    // Ensure the transaction is finalized
    this._ensureTxFinalization(transactionId, transaction);

    // Get chain configuration
    const chain = await getChain(chainId);
    const depository = chain.depository;
    if (!depository) {
      throw externalError("Chain has no depository configured");
    }

    // Get all OP_RETURN messages
    const decodedVouts = this._decodeTxOpReturnVouts(transaction.vout);

    // Extract the deposit id
    let depositId: string | undefined;
    let depositIdIndex: number | undefined;
    for (const { i, opReturn } of decodedVouts) {
      if (opReturn && opReturn.startsWith("0x") && opReturn.length >= 66) {
        // Take the first 32 bytes (64 hex chars + '0x')
        depositId = opReturn.slice(0, 66);
        depositIdIndex = i;
        break;
      }
    }

    // Get the depositor from the first transaction input
    let depositor: string | undefined;
    for (const input of transaction.vin) {
      await logRpcUsage(chainId, "getTransaction", trackingId);
      const inputTransaction = await rpc.getTransaction(input.txid);
      const vout = inputTransaction.vout[input.vout];
      if (vout && vout.scriptPubKey && vout.scriptPubKey.address) {
        depositor = vout.scriptPubKey.address;
        break;
      }
    }
    if (!depositor) {
      throw externalError("Could not determine depositor");
    }

    // Get the total amount sent to the depository
    const amount = transaction.vout.reduce((acc, output) => {
      if (output.scriptPubKey?.address === depository) {
        return acc + BigInt(output.value);
      }
      return acc;
    }, 0n);
    if (amount === 0n) {
      throw externalError("No value sent to the depository");
    }

    return [
      {
        data: {
          chainId,
          transactionId,
        },
        result: {
          onchainId: getDeterministicId(
            chainId,
            transactionId,
            (depositIdIndex ?? 0).toString(),
          ),
          depository,
          depositId: depositId ?? zeroHash,
          depositor,
          currency: getVmTypeNativeCurrency(VM_TYPE),
          amount: amount.toString(),
        },
        extraData: {
          timestamp: String(
            transaction.time ??
              (await rpc
                .getBlock(transaction.blockhash)
                .then((block) => block.time)),
          ),
        },
      },
    ];
  }

  public async getDepositoryWithdrawalMessage(
    chainId: string,
    withdrawal: string,
  ): Promise<DepositoryWithdrawalMessage> {
    const trackingId = getTrackingId();

    const rpc = await httpRpc(chainId);
    const chain = await getChain(chainId);

    const depository = chain.depository;
    if (!depository) {
      throw externalError("Chain has no depository configured");
    }

    const decodedWithdrawal = decodeWithdrawal(
      withdrawal,
      chain.vmType,
    ) as DecodedBitcoinVmWithdrawal;

    const psbt = bitcoin.Psbt.fromHex(decodedWithdrawal.withdrawal.psbt);

    // Decode all PSBT inputs
    const allocatorScript = bitcoin.address
      .toOutputScript(depository, bitcoin.networks.bitcoin)
      .toString("hex");
    const psbtInputs = psbt.data.inputs.map((input, i) => {
      const txid = Buffer.from(psbt.txInputs[i].hash).reverse().toString("hex");
      const vout = psbt.txInputs[i].index;

      return {
        ownedByAllocator:
          input.witnessUtxo?.script.toString("hex") === allocatorScript,
        txid,
        vout,
      };
    });
    if (!psbtInputs.filter((input) => input.ownedByAllocator).length) {
      throw externalError(
        "No allocator UTXOs detected as part of the withdrawal request",
      );
    }

    const esploraCompatibleApiUrl =
      chain.additionalData?.esploraCompatibleApiUrl;
    if (!esploraCompatibleApiUrl) {
      throw externalError("No Esplora-compatible API URL configured");
    }

    const accessToken = await this._getEsploraAccessToken(
      esploraCompatibleApiUrl,
    );

    // For every PSBT input, get the transaction that spent it
    const txidsSpendingPsbtInputs = new Set<string>();
    for (const input of psbtInputs) {
      await logRpcUsage(chainId, "outspend", trackingId);
      const outspend: {
        spent: boolean;
        txid?: string;
        vin?: number;
        status?: {
          confirmed: boolean;
        };
      } = await axios
        .get(
          `${esploraCompatibleApiUrl}/tx/${input.txid}/outspend/${input.vout}`,
          accessToken
            ? {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                },
              }
            : undefined,
        )
        .then((response) => response.data);
      if (outspend.spent && outspend.txid && outspend.status?.confirmed) {
        txidsSpendingPsbtInputs.add(outspend.txid);
      }
    }

    let status: DepositoryWithdrawalStatus;

    if (!txidsSpendingPsbtInputs.size) {
      // If we have no tx spending the allocator inputs, the PSBT is considered as pending
      status = DepositoryWithdrawalStatus.PENDING;
    } else if (txidsSpendingPsbtInputs.size > 1) {
      // If we have more than one tx spending the allocator inputs, the PSBT was never included onchain
      status = DepositoryWithdrawalStatus.EXPIRED;
    } else {
      // If we have exactly one tx spending the allocator inputs, confirm whether the PSBT matches that unique tx

      await logRpcUsage(chainId, "getRawTransaction", trackingId);
      const tx = bitcoin.Transaction.fromHex(
        await rpc.getRawTransaction(
          txidsSpendingPsbtInputs.values().next().value,
        ),
      );
      const psbtMatchesSpendingTx = psbt.data.inputs.every((input, i) => {
        if (input.witnessUtxo?.script.toString("hex") === allocatorScript) {
          const signature = input.partialSig?.[0]!;

          // PSBT values
          const psbtSignatureHex = Buffer.from(signature.signature).toString(
            "hex",
          );
          const psbtPubkeyHex = Buffer.from(signature.pubkey).toString("hex");

          // Onchain values
          const w = tx.ins[i]?.witness ?? [];
          const onchainSignatureHex = w[0]?.toString("hex");
          const onchainPubkeyHex = w[1]?.toString("hex");

          if (
            psbtSignatureHex === onchainSignatureHex &&
            psbtPubkeyHex === onchainPubkeyHex
          ) {
            return true;
          }

          return false;
        }

        return true;
      });
      if (psbtMatchesSpendingTx) {
        status = DepositoryWithdrawalStatus.EXECUTED;
      } else {
        status = DepositoryWithdrawalStatus.EXPIRED;
      }
    }

    const withdrawalId = getDecodedWithdrawalId(decodedWithdrawal);

    return {
      data: {
        chainId,
        withdrawal,
      },
      result: {
        withdrawalId,
        depository,
        status,
      },
    };
  }

  public async getSolverPaidAmount(
    chainId: string,
    transactionId: string,
    payment: {
      currency: string;
      recipient: string;
      orderId: string;
      extraData: string;
      deadline: number;
    },
  ): Promise<bigint> {
    const trackingId = getTrackingId();

    const rpc = await httpRpc(chainId);

    // Get transaction details
    await logRpcUsage(chainId, "getTransaction", trackingId);
    const transaction = await rpc.getTransaction(transactionId);
    if (!transaction) {
      throw externalError(`Transaction ${transactionId} not found`);
    }

    // Ensure the transaction is finalized
    this._ensureTxFinalization(transactionId, transaction);

    await logRpcUsage(chainId, "getBlock", trackingId);
    const transactionTimestamp = await rpc
      .getBlock(transaction.blockhash)
      .then((block) => block.time);
    if (transactionTimestamp > payment.deadline) {
      throw externalError(
        `Transaction ${transactionId} executed after deadline`,
      );
    }

    const decodedVouts = this._decodeTxOpReturnVouts(transaction.vout);
    if (!decodedVouts.some(({ opReturn }) => opReturn === payment.orderId)) {
      throw externalError(
        `Transaction ${transactionId} does not reference order id`,
      );
    }

    // Find the amount paid to the specified recipient in the transaction outputs
    let paidAmount = BigInt(0);
    for (const output of transaction.vout) {
      // Check if the output address matches the recipient address
      if (output.scriptPubKey.address === payment.recipient) {
        paidAmount += BigInt(output.value);
      }
    }

    return paidAmount;
  }

  public verifySolverCalls(
    _chainId: string,
    _transactionId: string,
    _calls: string[],
    _extraData: string,
  ): Promise<boolean> {
    throw internalError("Not implemented");
  }

  private _FINALIZATION_BLOCKS = 2;

  private _ensureTxFinalization(
    transactionId: string,
    tx: { confirmations?: number },
  ) {
    if (!tx.confirmations || tx.confirmations < this._FINALIZATION_BLOCKS) {
      throw externalError(`Transaction ${transactionId} is not finalized`);
    }
  }

  private _decodeTxOpReturnVouts(
    vouts: {
      value: number;
      n: number;
      scriptPubKey: {
        asm: string;
        desc: string;
        hex: string;
        type: string;
        address?: string;
      };
    }[],
  ) {
    return vouts.map((output, i) => {
      if (output.scriptPubKey.asm?.startsWith("OP_RETURN")) {
        try {
          if (output.scriptPubKey.hex.slice(2, 4) === "4c") {
            return {
              i,
              opReturn: Buffer.from(
                output.scriptPubKey.hex.slice(6),
                "hex",
              ).toString("utf8"),
            };
          } else {
            return {
              i,
              opReturn: Buffer.from(
                output.scriptPubKey.hex.slice(4),
                "hex",
              ).toString("utf8"),
            };
          }
        } catch {
          return { i, opReturn: undefined };
        }
      }

      return { i, opReturn: undefined };
    });
  }

  _esploraAccessToken: { token: string; expiration: number } | undefined;
  private async _getEsploraAccessToken(esploraCompatibleApiUrl: string) {
    if (
      this._esploraAccessToken &&
      this._esploraAccessToken.expiration > Math.floor(Date.now() / 1000)
    ) {
      return this._esploraAccessToken.token;
    }

    if (esploraCompatibleApiUrl.includes("enterprise.blockstream")) {
      const blockstreamLoginUrl =
        "https://login.blockstream.com/realms/blockstream-public/protocol/openid-connect/token";

      const params = new URLSearchParams();

      const clientId = process.env.BLOCKSTREAM_CLIENT_ID;
      const clientSecret = process.env.BLOCKSTREAM_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        throw externalError("Misconfigured Esplora-compatible API URL");
      }

      params.append("client_id", clientId);
      params.append("client_secret", clientSecret);
      params.append("grant_type", "client_credentials");
      params.append("scope", "openid");

      const options = {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params,
      };

      const data: any = await fetch(blockstreamLoginUrl, options).then(
        (response) => response.json(),
      );

      this._esploraAccessToken = {
        token: data.access_token,
        expiration: Math.floor(Date.now() / 1000) + data.expires_in,
      };
    }

    return this._esploraAccessToken?.token;
  }
}

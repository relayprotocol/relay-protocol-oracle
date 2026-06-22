import axios from "axios";
import * as bitcoin from "bitcoinjs-lib";
import { zeroHash } from "viem";

import {
  DecodedBitcoinVmWithdrawal,
  decodeWithdrawal,
  DenormalizedSubmitWithdrawRequest,
  DepositoryWithdrawalMessage,
  DepositoryWithdrawalStatus,
  getDecodedWithdrawalId,
  getVmTypeNativeCurrency,
} from "@relay-protocol/settlement-sdk";

import { getDeterministicId } from "../../utils";
import { EnhancedDepositoryDepositMessage, VmAttestor } from "../../vm/types";
import { Chain, getChain } from "../../../../common/chains";
import { externalError, internalError } from "../../../../common/error";
import { getTrackingId, logRpcUsage } from "../../../../common/rpc-usage";
import { httpRpc } from "../../../../common/vm/bitcoin-vm/rpc";

const VM_TYPE = "bitcoin-vm";

const DEPOSIT_ID_REGEX = /^0x[0-9a-fA-F]{64}$/;
const DEPOSITOR_REGEX = /\|depositor=([^|]+)(?=\|)/g;

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
    await this._ensureTxFinalization(chainId, transactionId, transaction);

    // Get chain configuration
    const chain = await getChain(chainId);
    const depository = chain.depository;
    const additionalDepositories = chain.additionalDepositories ?? [];
    if (!depository) {
      throw externalError("Chain has no depository configured");
    }

    const depositories = [depository, ...additionalDepositories];

    const inputPrevoutAddresses: string[] = [];
    for (const input of transaction.vin) {
      await logRpcUsage(chainId, "getTransaction", trackingId);
      const inputTransaction = await rpc.getTransaction(input.txid);
      if (!inputTransaction) {
        throw externalError(`Missing input transaction ${input.txid}`);
      }

      const inputPrevout = inputTransaction.vout[input.vout];
      if (!inputPrevout) {
        throw externalError(
          `Missing input prevout ${input.txid}:${input.vout}`,
        );
      }

      // Transactions that spend a depository UTXO are depository withdrawals
      // (possibly with change back to the depository). Do not attest their
      // outputs as user deposits.
      if (
        inputPrevout.scriptPubKey.address &&
        depositories.includes(inputPrevout.scriptPubKey.address)
      ) {
        return [];
      }

      if (inputPrevout.scriptPubKey.address) {
        inputPrevoutAddresses.push(inputPrevout.scriptPubKey.address);
      }
    }

    // Get all OP_RETURN messages
    const decodedVouts = this._decodeTxOpReturnVouts(transaction.vout);

    // Extract the deposit id
    let depositId: string | undefined;
    let depositIdIndex: number | undefined;
    for (const { i, opReturn } of decodedVouts) {
      if (opReturn && opReturn.startsWith("0x") && opReturn.length >= 66) {
        // Take the first 32 bytes (64 hex chars + '0x')
        const parsedDepositId = opReturn.slice(0, 66);
        if (!DEPOSIT_ID_REGEX.test(parsedDepositId)) {
          continue;
        }

        depositId = parsedDepositId;
        depositIdIndex = i;
        break;
      }
    }

    // Get the depositor from OP_RETURN metadata, or fall back to the first transaction input
    let depositor = this._extractExplicitDepositor(decodedVouts);
    if (!depositor) {
      depositor = inputPrevoutAddresses[0];
    }
    if (!depositor) {
      throw externalError("Could not determine depositor");
    }

    // Get the total amount sent to each depository
    const amountsByDepository = new Map(
      depositories.map((address) => [address, 0n]),
    );
    for (const output of transaction.vout) {
      const outputAddress = output.scriptPubKey.address;
      if (!outputAddress) {
        continue;
      }

      const currentAmount = amountsByDepository.get(outputAddress);
      if (currentAmount !== undefined) {
        amountsByDepository.set(
          outputAddress,
          currentAmount + BigInt(output.value),
        );
      }
    }

    const fundedDepositories = [...amountsByDepository.entries()].filter(
      ([, amount]) => amount > 0n,
    );
    if (fundedDepositories.length === 0) {
      throw externalError("No value sent to the depository");
    }
    if (fundedDepositories.length > 1) {
      throw externalError("Multiple depositories received funds");
    }
    const [[fundedDepository, amount]] = fundedDepositories;

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
          depository: fundedDepository,
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
    const additionalDepositories = chain.additionalDepositories ?? [];
    if (!depository) {
      throw externalError("Chain has no depository configured");
    }

    const decodedWithdrawal = decodeWithdrawal(
      withdrawal,
      chain.vmType,
    ) as DecodedBitcoinVmWithdrawal;

    const psbt = bitcoin.Psbt.fromHex(decodedWithdrawal.withdrawal.psbt);

    const allocatorScripts = [depository, ...additionalDepositories].map((d) =>
      bitcoin.address
        .toOutputScript(d, bitcoin.networks.bitcoin)
        .toString("hex"),
    );

    const psbtInputs = psbt.data.inputs.map((input, i) => {
      const txid = Buffer.from(psbt.txInputs[i].hash).reverse().toString("hex");
      const vout = psbt.txInputs[i].index;
      const prevoutScriptHex = this._getPsbtInputPrevoutScriptHex(
        psbt,
        i,
        input,
      );

      const ownedByAllocator =
        prevoutScriptHex && allocatorScripts.includes(prevoutScriptHex);
      return {
        ownedByAllocator,
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

    const authorizationHeader = await this._getEsploraAuthorizationHeader(
      esploraCompatibleApiUrl,
      chain.additionalData,
    );

    // For every PSBT input, get the transaction that spent it.
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
          {
            timeout: 10000,
            ...(authorizationHeader ? { headers: authorizationHeader } : {}),
          },
        )
        .then((response) => response.data);
      if (outspend.spent && outspend.txid && outspend.status?.confirmed) {
        txidsSpendingPsbtInputs.add(outspend.txid);
      }
    }

    let status: DepositoryWithdrawalStatus;

    if (!txidsSpendingPsbtInputs.size) {
      // If we have no tx spending the PSBT inputs, the PSBT is considered as pending
      status = DepositoryWithdrawalStatus.PENDING;
    } else if (txidsSpendingPsbtInputs.size > 1) {
      // If we have more than one tx spending the PSBT inputs, the PSBT was never included onchain
      status = DepositoryWithdrawalStatus.EXPIRED;
    } else {
      // If we have exactly one tx spending the PSBT inputs, confirm whether the PSBT matches that unique tx

      await logRpcUsage(chainId, "getRawTransaction", trackingId);
      const tx = bitcoin.Transaction.fromHex(
        await rpc.getRawTransaction(
          txidsSpendingPsbtInputs.values().next().value!,
        ),
      );
      const allocatorInputIndexes = psbtInputs
        .map((input, i) => ({ ...input, i }))
        .filter((input) => input.ownedByAllocator)
        .map((input) => input.i);

      const psbtHasAllocatorSignatures = allocatorInputIndexes.every(
        (i) => psbt.data.inputs[i].partialSig?.[0],
      );

      const psbtMatchesSpendingTx = psbtHasAllocatorSignatures
        ? this._psbtSignaturesMatchSpendingTx(psbt, tx, allocatorInputIndexes)
        : this._psbtOpReturnMatchesSpendingTx(psbt, tx);

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
    await this._ensureTxFinalization(chainId, transactionId, transaction);

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

  public async validateSubmitWithdrawRequest(
    data: DenormalizedSubmitWithdrawRequest,
  ): Promise<boolean> {
    if (!data.additionalData?.["bitcoin-vm"]) {
      return false;
    }

    const rpc = await httpRpc(data.chainId);
    for (const utxo of data.additionalData?.["bitcoin-vm"].allocatorUtxos) {
      const tx = await rpc.getTransaction(utxo.txid);
      if (Number(utxo.value) !== tx.vout[utxo.vout].value) {
        return false;
      }
    }

    return true;
  }

  private _DEFAULT_FINALIZATION_BLOCKS = 2;

  private async _getFinalizationBlocks(chainId: string): Promise<number> {
    const chain = await getChain(chainId);
    return (
      chain.additionalData?.finalizationBlocks ??
      this._DEFAULT_FINALIZATION_BLOCKS
    );
  }

  private async _ensureTxFinalization(
    chainId: string,
    transactionId: string,
    tx: { confirmations?: number },
  ) {
    const finalizationBlocks = await this._getFinalizationBlocks(chainId);
    if (!tx.confirmations || tx.confirmations < finalizationBlocks) {
      throw externalError(`Transaction ${transactionId} is not finalized`);
    }
  }

  private _extractExplicitDepositor(
    decodedVouts: { opReturn?: string }[],
  ): string | undefined {
    for (const { opReturn } of decodedVouts) {
      if (!opReturn) {
        continue;
      }

      for (const match of opReturn.matchAll(DEPOSITOR_REGEX)) {
        const depositor = match[1];
        try {
          bitcoin.address.toOutputScript(depositor, bitcoin.networks.bitcoin);
          return depositor;
        } catch {
          continue;
        }
      }
    }

    return undefined;
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
  private _getPsbtInputPrevoutScriptHex(
    psbt: bitcoin.Psbt,
    inputIndex: number,
    input: { witnessUtxo?: { script: Buffer }; nonWitnessUtxo?: Buffer },
  ): string | undefined {
    if (input.witnessUtxo) {
      return input.witnessUtxo.script.toString("hex");
    }

    if (input.nonWitnessUtxo) {
      const prevTx = bitcoin.Transaction.fromBuffer(input.nonWitnessUtxo);
      const prevoutIndex = psbt.txInputs[inputIndex].index;
      const prevout = prevTx.outs[prevoutIndex];
      if (!prevout) {
        throw externalError(
          `Unsupported allocator input format: prevout index out of range at input ${inputIndex}`,
        );
      }

      return prevout.script.toString("hex");
    }

    return undefined;
  }

  private _psbtSignaturesMatchSpendingTx(
    psbt: bitcoin.Psbt,
    tx: bitcoin.Transaction,
    allocatorInputIndexes: number[],
  ): boolean {
    return allocatorInputIndexes.every((i) => {
      const signature = psbt.data.inputs[i].partialSig?.[0];
      if (!signature) {
        throw externalError(
          `Unsupported allocator input format: missing partial signature at input ${i}`,
        );
      }

      // PSBT values
      const psbtSignatureHex = Buffer.from(signature.signature).toString("hex");
      const psbtPubkeyHex = Buffer.from(signature.pubkey).toString("hex");

      // Onchain values
      const onchainInput = tx.ins[i];
      if (!onchainInput) {
        throw externalError(
          `Unsupported allocator input format: missing onchain input ${i}`,
        );
      }
      const onchainSignature = this._extractOnchainSignature(onchainInput, i);
      if (!onchainSignature) {
        throw externalError(`Unsupported allocator input format at input ${i}`);
      }

      return (
        psbtSignatureHex === onchainSignature.signatureHex &&
        psbtPubkeyHex === onchainSignature.pubkeyHex
      );
    });
  }

  private _psbtOpReturnMatchesSpendingTx(
    psbt: bitcoin.Psbt,
    tx: bitcoin.Transaction,
  ): boolean {
    const psbtOpReturnScripts = this._getPsbtOpReturnScriptsHex(psbt);
    if (!psbtOpReturnScripts.length) {
      throw externalError(
        "Unsupported allocator input format: missing partial signatures and OP_RETURN identifier",
      );
    }

    const onchainOutputScripts = new Set(
      tx.outs
        .filter((output) => output.script[0] === bitcoin.opcodes.OP_RETURN)
        .map((output) => output.script.toString("hex")),
    );

    return psbtOpReturnScripts.some((script) => onchainOutputScripts.has(script));
  }

  private _getPsbtOpReturnScriptsHex(psbt: bitcoin.Psbt): string[] {
    return psbt.txOutputs
      .filter((output) => output.script[0] === bitcoin.opcodes.OP_RETURN)
      .map((output) => output.script.toString("hex"));
  }

  private _extractOnchainSignature(
    txInput: bitcoin.TxInput,
    inputIndex: number,
  ): { signatureHex: string; pubkeyHex: string } | undefined {
    if (txInput.witness?.length) {
      const signature = txInput.witness[0];
      const pubkey = txInput.witness[1];
      if (!signature || !pubkey || !this._isPubkey(pubkey)) {
        return undefined;
      }

      return {
        signatureHex: signature.toString("hex"),
        pubkeyHex: pubkey.toString("hex"),
      };
    }

    const decompiledScriptSig = bitcoin.script.decompile(txInput.script);
    if (!decompiledScriptSig) {
      throw externalError(
        `Unsupported allocator input format: could not decode scriptSig at input ${inputIndex}`,
      );
    }

    const dataPushes = decompiledScriptSig.filter((value) =>
      Buffer.isBuffer(value),
    );
    if (dataPushes.length < 2) {
      return undefined;
    }

    const signature = dataPushes[0] as Buffer;
    const pubkey = dataPushes[1] as Buffer;
    if (!this._isPubkey(pubkey)) {
      return undefined;
    }

    return {
      signatureHex: signature.toString("hex"),
      pubkeyHex: pubkey.toString("hex"),
    };
  }

  private _isPubkey(buffer: Buffer): boolean {
    return (
      (buffer.length === 33 && (buffer[0] === 0x02 || buffer[0] === 0x03)) ||
      (buffer.length === 65 && buffer[0] === 0x04)
    );
  }

  private async _getEsploraAuthorizationHeader(
    esploraCompatibleApiUrl: string,
    additionalData: Chain["additionalData"],
  ) {
    if (esploraCompatibleApiUrl.includes("enterprise.blockstream")) {
      if (
        this._esploraAccessToken &&
        this._esploraAccessToken.expiration > Math.floor(Date.now() / 1000)
      ) {
        return { Authorization: `Bearer ${this._esploraAccessToken.token}` };
      }

      const blockstreamLoginUrl =
        "https://login.blockstream.com/realms/blockstream-public/protocol/openid-connect/token";

      const params = new URLSearchParams();

      const clientId = additionalData?.blockstreamClientId;
      const clientSecret = additionalData?.blockstreamClientSecret;
      if (!clientId || !clientSecret) {
        throw externalError("Misconfigured Esplora-compatible API credentials");
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

      return { Authorization: `Bearer ${this._esploraAccessToken?.token}` };
    }

    if (esploraCompatibleApiUrl.includes("gomaestro-api")) {
      const apiKey = additionalData?.maestroApiKey;
      if (!apiKey) {
        throw externalError("Misconfigured Esplora-compatible API credentials");
      }

      return { "api-key": apiKey };
    }

    return undefined;
  }
}

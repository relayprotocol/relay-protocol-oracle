import * as hl from "@nktkas/hyperliquid";
import {
  DecodedHyperliquidVmWithdrawal,
  decodeWithdrawal,
  DepositoryWithdrawalMessage,
  DepositoryWithdrawalStatus,
  getDecodedWithdrawalId,
  getVmTypeNativeCurrency,
} from "@reservoir0x/relay-protocol-sdk";
import axios from "axios";
import { Hex, parseUnits, hashStruct } from "viem";

import { getDeterministicId } from "../utils";
import { EnhancedDepositoryDepositMessage, VmAttestor } from "../../vm/types";
import { getChain } from "../../../../common/chains";
import { externalError, internalError } from "../../../../common/error";
import { httpRpc } from "../../../../common/vm/hyperliquid-vm/rpc";

const VM_TYPE = "hyperliquid-vm";

const SPOT_USDC = "0x6d1e7cde53ba9467b783cb7c530ce054";

export class HyperliquidVmAttestor extends VmAttestor {
  public async getDepositoryDepositMessages(
    chainId: string,
    transactionId: string
  ): Promise<EnhancedDepositoryDepositMessage[]> {
    const rpc = await httpRpc(chainId);

    // Get transaction details
    const txDetails = await rpc.txDetails({
      hash: transactionId as Hex,
    });
    if (!txDetails) {
      throw externalError(
        `Missing transaction ${transactionId} on chain ${chainId}`
      );
    }
    if (txDetails.tx.error) {
      throw externalError(`Transaction failed: ${transactionId}`);
    }

    const chain = await getChain(chainId);
    const depository = chain.depository;
    if (!depository) {
      throw externalError("Chain has no depository configured");
    }

    const messages: EnhancedDepositoryDepositMessage[] = [];
    const timestamp = Math.floor(txDetails.tx.time / 1000).toString();

    switch (txDetails.tx.action.type) {
      case "usdSend": {
        const action = txDetails.tx.action as unknown as hl.UsdSendParameters;

        // Check if this is a deposit to the depository
        if (action.destination.toLowerCase() === depository.toLowerCase()) {
          const depositId = await this._lookupDepositId(
            chainId,
            txDetails.tx.user,
            txDetails.tx.time
          );

          messages.push({
            data: {
              chainId,
              transactionId,
            },
            result: {
              onchainId: getDeterministicId(chainId, transactionId, "0"),
              depository,
              depositId,
              depositor: txDetails.tx.user.toLowerCase(),
              currency: getVmTypeNativeCurrency(VM_TYPE),
              amount: parseUnits(
                Number(action.amount).toFixed(8),
                8
              ).toString(),
            },
            extraData: {
              timestamp,
            },
          });
        }

        break;
      }

      case "sendAsset": {
        const action = txDetails.tx.action as unknown as hl.SendAssetParameters;

        // Check if this is a deposit to the depository
        if (action.destination.toLowerCase() === depository.toLowerCase()) {
          const tokenAddress = action.token.split(":")[1];
          const tokenDex = action.destinationDex;
          if (tokenDex === "" && tokenAddress !== SPOT_USDC) {
            throw externalError("Only USDC is supported as a Perps token");
          }

          const currency =
            tokenDex === "spot"
              ? tokenAddress.toLowerCase()
              : tokenDex === ""
              ? getVmTypeNativeCurrency(VM_TYPE)
              : tokenAddress.toLowerCase() +
                Buffer.from(tokenDex, "ascii").toString("hex");

          const currencyDecimals =
            currency === getVmTypeNativeCurrency(VM_TYPE)
              ? 8
              : await rpc
                  .spotMeta()
                  .then(
                    (r) =>
                      r.tokens.find((t) => t.tokenId === tokenAddress)
                        ?.szDecimals
                  );
          if (currencyDecimals === undefined) {
            throw externalError("Could not retrieve payment currency decimals");
          }

          const depositId = await this._lookupDepositId(
            chainId,
            txDetails.tx.user,
            txDetails.tx.time
          );

          messages.push({
            data: {
              chainId,
              transactionId,
            },
            result: {
              onchainId: getDeterministicId(chainId, transactionId, "0"),
              depository,
              depositId,
              depositor: txDetails.tx.user.toLowerCase(),
              currency,
              amount: parseUnits(
                Number(action.amount).toFixed(currencyDecimals),
                currencyDecimals
              ).toString(),
            },
            extraData: {
              timestamp,
            },
          });
        }
        break;
      }

      default:
        // For other transaction types, return empty array
        break;
    }

    return messages;
  }

  public async getDepositoryWithdrawalMessage(
    chainId: string,
    withdrawal: string,
    transactionId?: string
  ): Promise<DepositoryWithdrawalMessage> {
    const chain = await getChain(chainId);

    const depository = chain.depository;
    if (!depository) {
      throw externalError("Chain has no depository configured");
    }

    const decodedWithdrawal = decodeWithdrawal(
      withdrawal,
      chain.vmType
    ) as DecodedHyperliquidVmWithdrawal;
    const withdrawalId = getDecodedWithdrawalId(decodedWithdrawal);

    let status: DepositoryWithdrawalStatus = DepositoryWithdrawalStatus.PENDING;

    // If a transaction id is provided, verify the withdrawal was executed in that transaction
    if (transactionId) {
      const rpc = await httpRpc(chainId);

      const txDetails = await rpc.txDetails({
        hash: transactionId as Hex,
      });
      if (!txDetails) {
        throw externalError(
          `Missing transaction ${transactionId} on chain ${chainId}`
        );
      }
      if (txDetails.tx.error) {
        throw externalError(`Transaction failed: ${transactionId}`);
      }

      // Verify transaction is from depository
      if (txDetails.tx.user.toLowerCase() === depository.toLowerCase()) {
        // Verify the transaction's message hash matches the withdrawal id
        const txMessageHash = this._getMessageHash(txDetails.tx.action);
        if (txMessageHash && withdrawalId === txMessageHash) {
          status = DepositoryWithdrawalStatus.EXECUTED;
        }
      }
    }

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
    }
  ): Promise<bigint> {
    const rpc = await httpRpc(chainId);

    // Ensure the transaction was successfully included
    const txDetails = await rpc.txDetails({
      hash: transactionId as Hex,
    });
    if (!txDetails || txDetails.tx.error) {
      throw externalError(`Missing or reverted transaction ${transactionId}`);
    }

    const transactionTimestamp = Math.floor(txDetails.tx.time / 1000);
    if (transactionTimestamp > payment.deadline) {
      throw externalError(
        `Transaction ${transactionId} executed after deadline`
      );
    }

    if (payment.currency === getVmTypeNativeCurrency(VM_TYPE)) {
      if (txDetails.tx.action.type === "usdSend") {
        const txParameters = txDetails.tx
          .action as unknown as hl.UsdSendParameters;
        if (
          txParameters.destination.toLowerCase() ===
          payment.recipient.toLowerCase()
        ) {
          return parseUnits(Number(txParameters.amount).toFixed(8), 8);
        }
      }

      throw externalError("Could not detect payment");
    } else {
      if (txDetails.tx.action.type === "sendAsset") {
        const txParameters = txDetails.tx
          .action as unknown as hl.SendAssetParameters;

        const [orderPaymentCurrency, orderPaymentDex] = [
          payment.currency.slice(0, 34),
          payment.currency.slice(34) === ""
            ? "spot"
            : Buffer.from(payment.currency.slice(34), "hex").toString("ascii"),
        ];
        const [actualPaymentCurrency, actualPaymentDex] = [
          txParameters.token.split(":")[1],
          txParameters.destinationDex,
        ];

        if (
          txParameters.destination.toLowerCase() ===
            payment.recipient.toLowerCase() &&
          orderPaymentCurrency.toLowerCase() ===
            actualPaymentCurrency.toLowerCase() &&
          orderPaymentDex === actualPaymentDex
        ) {
          const currencyDecimals = await rpc
            .spotMeta()
            .then(
              (r) =>
                r.tokens.find((t) => t.tokenId === actualPaymentCurrency)
                  ?.szDecimals
            );
          if (currencyDecimals === undefined) {
            throw externalError("Could not retrieve payment currency decimals");
          }

          return parseUnits(
            Number(txParameters.amount).toFixed(currencyDecimals),
            currencyDecimals
          );
        }
      }

      throw externalError("Could not detect payment");
    }
  }

  public async verifySolverCalls(
    _chainId: string,
    _transactionId: string,
    _calls: string[]
  ): Promise<boolean> {
    throw internalError("Not implemented (verifySolverCalls)");
  }

  private async _lookupDepositId(
    chainId: string,
    depositor: string,
    nonce: number
  ): Promise<string> {
    const chain = await getChain(chainId);

    const hubApiUrl = chain.additionalData?.hubApiUrl;
    if (!hubApiUrl) {
      throw externalError("Chain has no hub API URL configured");
    }

    const data = await axios
      .get(`${hubApiUrl}/queries/deposits/by-nonce/${nonce}/${depositor}`)
      .then((response) => response.data as { depositId?: string });
    if (!data.depositId) {
      throw externalError(
        `No depositId found for nonce ${nonce} and depositor ${depositor}`
      );
    }

    return data.depositId;
  }

  private _getMessageHash(action: any): string | undefined {
    switch (action.type) {
      case "usdSend": {
        return hashStruct({
          types: {
            "HyperliquidTransaction:UsdSend": [
              { name: "hyperliquidChain", type: "string" },
              { name: "destination", type: "string" },
              { name: "amount", type: "string" },
              { name: "time", type: "uint64" },
            ],
          },
          primaryType: "HyperliquidTransaction:UsdSend",
          data: {
            hyperliquidChain: action.hyperliquidChain,
            destination: action.destination,
            amount: action.amount,
            time: action.time,
          },
        });
      }

      case "sendAsset": {
        return hashStruct({
          types: {
            "HyperliquidTransaction:SendAsset": [
              { name: "hyperliquidChain", type: "string" },
              { name: "destination", type: "string" },
              { name: "sourceDex", type: "string" },
              { name: "destinationDex", type: "string" },
              { name: "token", type: "string" },
              { name: "amount", type: "string" },
              { name: "fromSubAccount", type: "string" },
              { name: "nonce", type: "uint64" },
            ],
          },
          primaryType: "HyperliquidTransaction:SendAsset",
          data: {
            hyperliquidChain: action.hyperliquidChain,
            destination: action.destination,
            sourceDex: action.sourceDex,
            destinationDex: action.destinationDex,
            token: action.token,
            amount: action.amount,
            fromSubAccount: action.fromSubAccount,
            nonce: action.nonce,
          },
        });
      }

      default: {
        return undefined;
      }
    }
  }
}

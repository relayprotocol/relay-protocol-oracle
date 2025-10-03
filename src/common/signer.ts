import {
  DepositoryDepositMessage,
  DepositoryWithdrawalMessage,
  ExecutionMessage,
  getDepositoryDepositMessageId,
  getDepositoryWithdrawalMessageId,
  getSolverFillMessageId,
  getSolverRefundMessageId,
  SolverFillMessage,
  SolverRefundMessage,
} from "@reservoir0x/relay-protocol-sdk";
import { createWalletClient, Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { getSdkChainsConfig } from "./chains";
import { config } from "../config";

const getSigningWallet = () => {
  return createWalletClient({
    account: privateKeyToAccount(config.ecdsaPrivateKey as Hex),
    // Viem will error if we pass no URL to the `http` transport, so here we
    // just pass a mock URL, which isn't even going to be used since we only
    // use `walletClient` for signing messages offchain
    transport: http("http://localhost:1"),
  });
};

const sign = async (data: Hex) => {
  const walletClient = getSigningWallet();

  return {
    oracle: walletClient.account.address.toLowerCase(),
    signature: await walletClient.signMessage({
      message: {
        raw: data,
      },
    }),
  };
};

export const signDepositoryDepositMessage = async (
  m: DepositoryDepositMessage
) => sign(getDepositoryDepositMessageId(m, await getSdkChainsConfig()));

export const signDepositoryWithdrawalMessage = async (
  m: DepositoryWithdrawalMessage
) => sign(getDepositoryWithdrawalMessageId(m, await getSdkChainsConfig()));

export const signSolverFillMessage = async (m: SolverFillMessage) =>
  sign(getSolverFillMessageId(m, await getSdkChainsConfig()));

export const signSolverRefundMessage = async (m: SolverRefundMessage) =>
  sign(getSolverRefundMessageId(m, await getSdkChainsConfig()));

export const signExecutionMessage = async (m: ExecutionMessage) => {
  const walletClient = getSigningWallet();

  const signature = await walletClient.signTypedData({
    domain: {
      chainId: BigInt(config.onChainOracleChainId),
      name: "RelayOracle",
      verifyingContract: config.onChainOracleAddress as `0x${string}`,
      version: "1",
    },
    message: {
      actions: m.actions as Hex[],
      idempotencyKey: m.idempotencyKey as Hex,
    },
    primaryType: "Execution",
    types: {
      Execution: [
        {
          name: "idempotencyKey",
          type: "bytes32",
        },
        {
          name: "actions",
          type: "bytes[]",
        },
      ],
    },
  });

  return {
    oracle: walletClient.account.address.toLowerCase(),
    signature,
  };
};

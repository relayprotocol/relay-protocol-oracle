import {
  EscrowDepositMessage,
  EscrowWithdrawalMessage,
  getEscrowDepositMessageId,
  getEscrowWithdrawalMessageId,
  getSolverFillMessageId,
  getSolverRefundMessageId,
  SolverFillMessage,
  SolverRefundMessage,
} from "@reservoir0x/relay-protocol-sdk";
import { createWalletClient, Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { getSdkChainsConfig } from "./chains";
import { config } from "../config";

const sign = async (data: Hex) => {
  const walletClient = createWalletClient({
    account: privateKeyToAccount(config.ecdsaPrivateKey as Hex),
    // Viem will error if we pass no URL to the `http` transport, so here we
    // just pass a mock URL, which isn't even going to be used since we only
    // use `walletClient` for signing messages offchain
    transport: http("http://localhost:1"),
  });

  return {
    oracle: walletClient.account.address.toLowerCase(),
    signature: await walletClient.signMessage({
      message: {
        raw: data,
      },
    }),
  };
};

export const signEscrowDepositMessage = async (m: EscrowDepositMessage) =>
  sign(getEscrowDepositMessageId(m, await getSdkChainsConfig()));

export const signEscrowWithdrawalMessage = async (m: EscrowWithdrawalMessage) =>
  sign(getEscrowWithdrawalMessageId(m, await getSdkChainsConfig()));

export const signSolverFillMessage = async (m: SolverFillMessage) =>
  sign(getSolverFillMessageId(m, await getSdkChainsConfig()));

export const signSolverRefundMessage = async (m: SolverRefundMessage) =>
  sign(getSolverRefundMessageId(m, await getSdkChainsConfig()));

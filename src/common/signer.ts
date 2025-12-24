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
import { Hex } from "viem";

import { getHubChain, getHubChains, getSdkChainsConfig } from "./chains";
import { config } from "../config";
import { getSigningWallet, SigningModule } from "../signers";

const sign = async (data: Hex) => {
  const wallet = await getSigningWallet(
    (config.signingModule as SigningModule) ?? "raw-private-key"
  );

  return {
    oracle: wallet.address.toLowerCase(),
    signature: await wallet.signMessage({
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
  const signatures = await Promise.all(
    Object.values(await getHubChains()).map(async (chain) => {
      return signExecutionMessageForChain(m, chain.id);
    })
  );
  return signatures;
};

export const signExecutionMessageForChain = async (
  m: ExecutionMessage,
  chainId: string
) => {
  const wallet = await getSigningWallet(
    (config.signingModule as SigningModule) ?? "raw-private-key"
  );

  const {
    hubChainId: oracleChainId,
    additionalData: { oracleAddress },
  } = await getHubChain(chainId);

  const signature = await wallet.signTypedData({
    domain: {
      chainId: BigInt(oracleChainId!),
      name: "RelayOracle",
      verifyingContract: oracleAddress as `0x${string}`,
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
    oracleChainId: BigInt(oracleChainId!),
    oracleContract: oracleAddress as `0x${string}`,
    oracleSigner: wallet.address.toLowerCase(),
    signature,
  };
};

export const signProofOfWithdrawalAddressBalance = async (
  proofOfWithdrawalAddressBalance: string
) => sign(proofOfWithdrawalAddressBalance as `0x${string}`);

import {
  ExecutionMessage,
  GenericMappingMessage,
  SubmitWithdrawRequest,
} from "@relay-protocol/settlement-sdk";
import { Address, Hex } from "viem";

import { getHubChain, getHubChains } from "./chains";
import { config } from "../config";
import { getSigningWallet, SigningModule } from "../signers";

export const signGenericMappingMessage = async (m: GenericMappingMessage) => {
  const signatures = await Promise.all(
    Object.values(await getHubChains()).map(async (chain) => {
      return signGenericMappingMessageForChain(m, chain.id);
    }),
  );
  return signatures;
};

export const signGenericMappingMessageForChain = async (
  m: GenericMappingMessage,
  chainId: string,
) => {
  const wallet = await getSigningWallet(
    (config.signingModule as SigningModule) ?? "raw-private-key",
  );

  const { hubChainId: genericMappingChainId, additionalData } =
    await getHubChain(chainId);

  const signature = await wallet.signTypedData({
    domain: {
      chainId: BigInt(genericMappingChainId!),
      name: "RelayGenericMapping",
      verifyingContract: additionalData!.genericMappingAddress! as Address,
      version: "1",
    },
    message: {
      user: m.user as Address,
      id: m.id as Hex,
      data: m.data as Hex,
      nonce: m.nonce as Hex,
    },
    primaryType: "SetEntry",
    types: {
      SetEntry: [
        { name: "user", type: "address" },
        { name: "id", type: "bytes32" },
        { name: "data", type: "bytes" },
        { name: "nonce", type: "bytes32" },
      ],
    },
  });

  return {
    genericMappingChainId: BigInt(genericMappingChainId!),
    genericMappingContract: additionalData!.genericMappingAddress! as Address,
    oracleSigner: wallet.address.toLowerCase(),
    signature,
  };
};

export const signPayloadParamsMessage = async (m: SubmitWithdrawRequest) => {
  const signatures = await Promise.all(
    Object.values(await getHubChains()).map(async (chain) => {
      return signPayloadParamsForChain(m, chain.id);
    }),
  );
  return signatures;
};

export const signPayloadParamsForChain = async (
  m: SubmitWithdrawRequest,
  chainId: string,
) => {
  const wallet = await getSigningWallet(
    (config.signingModule as SigningModule) ?? "raw-private-key",
  );

  const { additionalData } = await getHubChain(chainId);

  const signature = await wallet.signTypedData({
    domain: {
      chainId: additionalData!.auroraChainId!,
      name: "RelayAllocatorSpender",
      verifyingContract: additionalData!
        .auroraAllocatorSpenderAddress! as Address,
      version: "1",
    },
    message: {
      chainId: BigInt(m.chainId),
      depository: m.depository,
      currency: m.currency,
      amount: BigInt(m.amount),
      spender: m.spender as Address,
      receiver: m.recipient,
      data: m.data as Hex,
      nonce: m.nonce as Hex,
    },
    primaryType: "SubmitWithdrawRequest",
    types: {
      SubmitWithdrawRequest: [
        {
          name: "chainId",
          type: "uint256",
        },
        {
          name: "depository",
          type: "string",
        },
        {
          name: "currency",
          type: "string",
        },
        {
          name: "amount",
          type: "uint256",
        },
        {
          name: "spender",
          type: "address",
        },
        {
          name: "receiver",
          type: "string",
        },
        {
          name: "data",
          type: "bytes",
        },
        {
          name: "nonce",
          type: "bytes32",
        },
      ],
    },
  });

  return {
    allocatorSpenderChainId: BigInt(additionalData!.auroraChainId!),
    allocatorSpenderContract: additionalData!
      .auroraAllocatorSpenderAddress! as Address,
    oracleSigner: wallet.address.toLowerCase(),
    signature,
  };
};

export const signExecutionMessage = async (m: ExecutionMessage) => {
  const signatures = await Promise.all(
    Object.values(await getHubChains()).map(async (chain) => {
      return signExecutionMessageForChain(m, chain.id);
    }),
  );
  return signatures;
};

export const signExecutionMessageForChain = async (
  m: ExecutionMessage,
  chainId: string,
) => {
  const wallet = await getSigningWallet(
    (config.signingModule as SigningModule) ?? "raw-private-key",
  );

  const { hubChainId: oracleChainId, additionalData } =
    await getHubChain(chainId);

  const signature = await wallet.signTypedData({
    domain: {
      chainId: BigInt(oracleChainId!),
      name: "RelayOracle",
      verifyingContract: additionalData!.oracleAddress as Address,
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
    oracleContract: additionalData!.oracleAddress as Address,
    oracleSigner: wallet.address.toLowerCase(),
    signature,
  };
};

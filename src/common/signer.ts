import {
  ExecutionMessage,
  GenericMappingMessage,
  SubmitWithdrawRequest,
} from "@relay-protocol/settlement-sdk";
import { Address, Hex, zeroAddress } from "viem";

import { getHubInfo } from "./chains";
import { getSigningWallet } from "../signers";

export const signGenericMappingMessage = async (m: GenericMappingMessage) => {
  const wallet = await getSigningWallet();

  const hubInfo = await getHubInfo();

  const signature = await wallet.signTypedData({
    domain: {
      chainId: BigInt(hubInfo.evmChainId),
      name: "RelayGenericMapping",
      verifyingContract: hubInfo.genericMappingAddress as Address,
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
    genericMappingChainId: BigInt(hubInfo.evmChainId),
    genericMappingContract: hubInfo.genericMappingAddress as Address,
    oracleSigner: wallet.address.toLowerCase(),
    signature,
  };
};

export const signPayloadParams = async (m: SubmitWithdrawRequest) => {
  const wallet = await getSigningWallet();

  const hubInfo = await getHubInfo();

  const signature = await wallet.signTypedData({
    domain: {
      chainId: BigInt(hubInfo.auroraEvmChainId),
      name: "RelayAllocatorSpender",
      verifyingContract: hubInfo.auroraAllocatorSpenderAddress as Address,
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
    allocatorSpenderChainId: BigInt(hubInfo.auroraEvmChainId),
    allocatorSpenderContract: hubInfo.auroraAllocatorSpenderAddress as Address,
    oracleSigner: wallet.address.toLowerCase(),
    signature,
  };
};

export const signCanonicalHubBlockMessage = async (m: {
  chainId: number;
  blockNumber: bigint;
  blockHash: string;
  stateRoot: string;
}) => {
  const wallet = await getSigningWallet();

  const signature = await wallet.signTypedData({
    domain: {
      chainId: BigInt(m.chainId),
      name: "CanonicalHubBlock",
      verifyingContract: zeroAddress,
      version: "1",
    },
    message: {
      chainId: BigInt(m.chainId),
      blockNumber: m.blockNumber,
      blockHash: m.blockHash as Hex,
      stateRoot: m.stateRoot as Hex,
    },
    primaryType: "CanonicalHubBlock",
    types: {
      CanonicalHubBlock: [
        {
          name: "chainId",
          type: "uint256",
        },
        {
          name: "blockNumber",
          type: "uint256",
        },
        {
          name: "blockHash",
          type: "bytes32",
        },
        {
          name: "stateRoot",
          type: "bytes32",
        },
      ],
    },
  });

  return {
    oracleSigner: wallet.address.toLowerCase(),
    signature,
  };
};

export const signExecutionMessage = async (m: ExecutionMessage) => {
  const wallet = await getSigningWallet();

  const hubInfo = await getHubInfo();

  const signature = await wallet.signTypedData({
    domain: {
      chainId: BigInt(hubInfo.evmChainId),
      name: "RelayOracle",
      verifyingContract: hubInfo.oracleAddress as Address,
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
    oracleChainId: BigInt(hubInfo.evmChainId),
    oracleContract: hubInfo.oracleAddress as Address,
    oracleSigner: wallet.address.toLowerCase(),
    signature,
  };
};

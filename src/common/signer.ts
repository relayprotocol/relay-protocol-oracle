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

export const signDepositAddressTriggerMessage = async (m: {
  chainId: string;
  depositAddressManager: string;
  inputDepository: string;
  triggerHash: string;
}) => {
  const wallet = await getSigningWallet();

  const signature = await wallet.signTypedData({
    domain: {
      chainId: BigInt(m.chainId),
      name: "Trigger",
      verifyingContract: zeroAddress,
      version: "1",
    },
    message: {
      chainId: BigInt(m.chainId),
      depositAddressManager: m.depositAddressManager as Address,
      inputDepository: m.inputDepository as Hex,
      triggerHash: m.triggerHash as Hex,
    },
    primaryType: "Trigger",
    types: {
      Trigger: [
        {
          name: "chainId",
          type: "uint256",
        },
        {
          name: "depositAddressManager",
          type: "address",
        },
        {
          name: "inputDepository",
          type: "bytes",
        },
        {
          name: "triggerHash",
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

export const signWithdrawRequestMessage = async (m: {
  chainId: number;
  allocator: string;
  withdrawRequestHash: string;
  hashesToSign: string[];
}) => {
  const wallet = await getSigningWallet();

  const signature = await wallet.signTypedData({
    domain: {
      chainId: BigInt(m.chainId),
      name: "WithdrawRequest",
      verifyingContract: zeroAddress,
      version: "1",
    },
    message: {
      chainId: BigInt(m.chainId),
      allocator: m.allocator as Address,
      withdrawRequestHash: m.withdrawRequestHash as Hex,
      hashesToSign: m.hashesToSign as Hex[],
    },
    primaryType: "WithdrawRequest",
    types: {
      WithdrawRequest: [
        {
          name: "chainId",
          type: "uint256",
        },
        {
          name: "allocator",
          type: "address",
        },
        {
          name: "withdrawRequestHash",
          type: "bytes32",
        },
        {
          name: "hashesToSign",
          type: "bytes32[]",
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

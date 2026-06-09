// ABOUTME: Unit tests for the allocator WithdrawRequest EIP-712 signer.
// ABOUTME: Guards the cross-repo signing scheme against silent domain/type drift.

import { describe, expect, it, jest } from "@jest/globals";
import {
  concat,
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  recoverAddress,
  toBytes,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const wallet = privateKeyToAccount(generatePrivateKey());

const HUB_INFO = {
  evmChainId: "421614",
  allocatorAddress: "0x6544a81a7e3961b35040f6fc848294367822b6b9" as Hex,
};

jest.mock("../../../src/common/chains", () => ({
  getHubInfo: jest.fn(async () => HUB_INFO),
}));
jest.mock("../../../src/signers", () => ({
  getSigningWallet: jest.fn(async () => wallet),
}));

import { signAllocatorWithdrawRequest } from "../../../src/common/signer";

// Must match RelayAllocator.sol PAYLOAD_TYPEHASH exactly — the digest the
// allocator's ORACLE.isValidSignatureNow verifies on-chain.
const PAYLOAD_TYPE_STRING =
  "WithdrawRequest(string chainId,bytes depository,bytes currency,uint256 amount,string spenderChainId,bytes spender,bytes receiver,bytes data,bytes32 nonce)";
const PAYLOAD_TYPEHASH =
  "0x607f56696940662f96b0996cc9f62f1dd868443a60cb469824be9cff6595b21d";

const request = {
  chainId: "421614",
  depository: `0x${"11".repeat(20)}` as Hex,
  currency: `0x${"22".repeat(20)}` as Hex,
  amount: "1000000",
  spenderChainId: "8453",
  spender: `0x${"33".repeat(20)}` as Hex,
  receiver: `0x${"44".repeat(20)}` as Hex,
  data: "0x" as Hex,
  nonce: `0x${"55".repeat(32)}` as Hex,
};

// Recompute the contract's `_withdrawRequestDigest` independently so a wrong
// field order/type/domain in the signer fails recovery.
const computeContractDigest = (): Hex => {
  const domainTypehash = keccak256(
    toBytes(
      "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    ),
  );
  const domainSeparator = keccak256(
    encodeAbiParameters(
      parseAbiParameters("bytes32, bytes32, bytes32, uint256, address"),
      [
        domainTypehash,
        keccak256(toBytes("RelayAllocator")),
        keccak256(toBytes("1")),
        BigInt(HUB_INFO.evmChainId),
        HUB_INFO.allocatorAddress,
      ],
    ),
  );

  const structHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "bytes32, bytes32, bytes32, bytes32, uint256, bytes32, bytes32, bytes32, bytes32, bytes32",
      ),
      [
        PAYLOAD_TYPEHASH as Hex,
        keccak256(toBytes(request.chainId)),
        keccak256(request.depository),
        keccak256(request.currency),
        BigInt(request.amount),
        keccak256(toBytes(request.spenderChainId)),
        keccak256(request.spender),
        keccak256(request.receiver),
        keccak256(request.data),
        request.nonce,
      ],
    ),
  );

  return keccak256(concat(["0x1901", domainSeparator, structHash]));
};

describe("signAllocatorWithdrawRequest", () => {
  it("anchors the EIP-712 type string to the contract PAYLOAD_TYPEHASH", () => {
    expect(keccak256(toBytes(PAYLOAD_TYPE_STRING))).toBe(PAYLOAD_TYPEHASH);
  });

  it("signs the contract WithdrawRequest digest with the oracle key", async () => {
    const result = await signAllocatorWithdrawRequest(request as never);

    expect(result.allocatorChainId).toBe(Number(HUB_INFO.evmChainId));
    expect(result.allocatorContract).toBe(HUB_INFO.allocatorAddress);
    expect(result.oracleSigner).toBe(wallet.address.toLowerCase());

    const recovered = await recoverAddress({
      hash: computeContractDigest(),
      signature: result.signature as Hex,
    });
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });
});

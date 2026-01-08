import { randomBytes } from "crypto";
import { getAddress } from "ethers";
import { WithdrawalAddressRequest } from "@relay-protocol/settlement-sdk";

function generateAddress() {
  const bytes = randomBytes(20); // 20 bytes = 160 bits
  return getAddress("0x" + bytes.toString("hex")); // checksum-format
}

export function randomBytes32() {
  return "0x" + randomBytes(32).toString("hex");
}

/**
 * Creates a mock WithdrawalAddressRequest for testing
 */
export function createMockWithdrawalAddressRequest(
  overrides?: Partial<WithdrawalAddressRequest>
): WithdrawalAddressRequest {
  return {
    chainId: overrides?.chainId || "ethereum",
    currency: overrides?.currency || generateAddress(),
    withdrawer: overrides?.withdrawer || generateAddress(),
    withdrawerChainId: overrides?.withdrawerChainId || "base",
    recipient: overrides?.recipient || generateAddress(),
    withdrawalNonce: overrides?.withdrawalNonce || randomBytes32(),
  };
}

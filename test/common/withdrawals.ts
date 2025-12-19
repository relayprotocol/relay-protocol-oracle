import { randomBytes } from "crypto";
import { getAddress } from "ethers";
import { WithdrawalAddressRequest } from "../../src/services/attestation";

function generateAddress() {
  const bytes = randomBytes(20); // 20 bytes = 160 bits
  return getAddress("0x" + bytes.toString("hex")); // checksum-format
}

function randomBytes32() {
  return "0x" + randomBytes(32).toString("hex");
}

/**
 * Creates a mock WithdrawalAddressRequest for testing
 */
export function createMockWithdrawalAddressRequest(
  overrides?: Partial<WithdrawalAddressRequest> & { ownerChainId?: string }
): WithdrawalAddressRequest & { ownerChainId: string } {
  return {
    depositoryAddress: overrides?.depositoryAddress || generateAddress(),
    depositoryChainSlug: overrides?.depositoryChainSlug || "ethereum",
    currency: overrides?.currency || generateAddress(),
    owner: overrides?.owner || generateAddress(),
    ownerChainId: overrides?.ownerChainId || "base",
    recipientAddress: overrides?.recipientAddress || generateAddress(),
    amount: overrides?.amount || "1000000000000000000",
    withdrawalNonce: overrides?.withdrawalNonce || randomBytes32(),
  };
}

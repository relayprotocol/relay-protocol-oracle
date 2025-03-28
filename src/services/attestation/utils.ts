import crypto from "crypto";

export const getMessageId = (
  chainId: number,
  transactionId: string,
  entryId: string
) =>
  "0x" +
  crypto
    .createHash("sha256")
    .update(`${chainId}:${transactionId}:${entryId}`.toLowerCase())
    .digest("hex");

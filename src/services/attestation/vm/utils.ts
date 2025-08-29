import crypto from "crypto";

export const getDeterministicId = (...values: string[]) =>
  "0x" +
  crypto
    .createHash("sha256")
    .update(values.join(":").toLowerCase())
    .digest("hex");

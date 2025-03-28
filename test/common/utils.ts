import { randomBytes } from "crypto";

export const randomHex = (size: number) =>
  "0x" + randomBytes(size).toString("hex");

export const randomNumber = (max: number) =>
  Number(BigInt(randomHex(5)).toString()) % max;

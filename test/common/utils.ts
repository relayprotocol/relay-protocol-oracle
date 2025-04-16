import { randomBytes } from "crypto";

export const randomHex = (size: number) =>
  "0x" + randomBytes(size).toString("hex");

export const randomBase58 = (size: number) =>
  // For testing purposes, we treat base64 as equivalent to base58
  "0x" + randomBytes(size).toString("base64");

export const randomNumber = (max: number) =>
  Number(BigInt(randomHex(5)).toString()) % max;

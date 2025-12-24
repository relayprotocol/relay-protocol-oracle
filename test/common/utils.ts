import { randomBytes } from "crypto";
import bs58 from "bs58";

export const ONE_BILLION = 1_000_000_000;

export const randomHex = (size: number) =>
  "0x" + randomBytes(size).toString("hex");

export const randomBase58 = (size: number) =>
  // For testing purposes, we treat base64 as equivalent to base58
  bs58.encode(randomBytes(size));

export const randomNumber = (max: number) =>
  Number(BigInt(randomHex(5)).toString()) % max;

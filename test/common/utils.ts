import { randomBytes } from "crypto";
import bs58 from 'bs58';

export const randomHex = (size: number) =>
  "0x" + randomBytes(size).toString("hex");

export const randomBase58 = (size: number) =>
  // For testing purposes, we treat base64 as equivalent to base58
  "0x" + randomBytes(size).toString("base64");

export const randomNumber = (max: number) =>
  Number(BigInt(randomHex(5)).toString()) % max;

export const randomBs58 = (size: number = 32) => 
  bs58.encode(randomBytes(size));

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(generatePrivateKey());
const mockGetAccount = jest.fn<() => Promise<typeof account>>();
const mockKmsSigner = jest.fn().mockImplementation(() => ({
  getAccount: mockGetAccount,
}));

jest.mock("../../../src/signers/aws-kms", () => ({
  KmsSigner: mockKmsSigner,
}));

jest.mock("../../../src/config", () => ({
  config: {
    signingModule: "aws-kms",
    ecdsaPrivateKey: privateKey,
    awsKmsSignerKeyId: "test-key",
    awsKmsSignerKeyRegion: "us-east-1",
  },
}));

type GetSigningWallet = (typeof import("../../../src/signers"))["getSigningWallet"];

let getSigningWallet: GetSigningWallet;

describe("signing wallet cache", () => {
  beforeEach(async () => {
    jest.resetModules();
    mockGetAccount.mockReset();
    mockGetAccount.mockResolvedValue(account);
    mockKmsSigner.mockClear();
    ({ getSigningWallet } = await import("../../../src/signers"));
  });

  it("reuses the raw private key account", async () => {
    const first = await getSigningWallet("raw-private-key");
    const second = await getSigningWallet("raw-private-key");

    expect(second).toBe(first);
  });

  it("reuses the KMS account across sequential signing operations", async () => {
    const first = await getSigningWallet("aws-kms");
    const second = await getSigningWallet("aws-kms");

    expect(first).toBe(account);
    expect(second).toBe(first);
    expect(mockKmsSigner).toHaveBeenCalledTimes(1);
    expect(mockGetAccount).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent account initialization", async () => {
    const wallets = await Promise.all(
      Array.from({ length: 10 }, () => getSigningWallet("aws-kms")),
    );

    expect(wallets.every((wallet) => wallet === account)).toBe(true);
    expect(mockKmsSigner).toHaveBeenCalledTimes(1);
    expect(mockGetAccount).toHaveBeenCalledTimes(1);
  });

  it("retries account initialization after a transient failure", async () => {
    mockGetAccount.mockRejectedValueOnce(new Error("KMS unavailable"));

    await expect(getSigningWallet("aws-kms")).rejects.toThrow(
      "KMS unavailable",
    );
    await expect(getSigningWallet("aws-kms")).resolves.toBe(account);

    expect(mockKmsSigner).toHaveBeenCalledTimes(2);
    expect(mockGetAccount).toHaveBeenCalledTimes(2);
  });
});

import { Account, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { KmsSigner } from "./aws-kms";
import { logger } from "../common/logger";
import { config } from "../config";

export type SigningModule = "raw-private-key" | "aws-kms";

type SigningWallet = Account & Required<Pick<Account, "signMessage">>;

const DEFAULT_SIGNING_MODULE: SigningModule = "raw-private-key";

let defaultWarningEmitted = false;
let __cachedSigningWallet: Promise<SigningWallet> | undefined;

export const getSigningModule = (): SigningModule => {
  if (config.signingModule) {
    return config.signingModule as SigningModule;
  }

  if (!defaultWarningEmitted) {
    defaultWarningEmitted = true;
    logger.warn(
      "signers",
      JSON.stringify({
        msg: `SIGNING_MODULE env var is not set; defaulting to "${DEFAULT_SIGNING_MODULE}". A raw ECDSA private key will be held in process memory. Set SIGNING_MODULE explicitly (e.g. "aws-kms") for production deployments.`,
      }),
    );
  }

  return DEFAULT_SIGNING_MODULE;
};

const createSigningWallet = async (
  module: SigningModule,
): Promise<SigningWallet> => {
  switch (module) {
    case "raw-private-key": {
      if (!config.ecdsaPrivateKey) {
        throw new Error(`Missing configuration for ${module} signing moduke`);
      }

      return privateKeyToAccount(config.ecdsaPrivateKey as Hex);
    }

    case "aws-kms": {
      if (!config.awsKmsSignerKeyId || !config.awsKmsSignerKeyRegion) {
        throw new Error(`Missing configuration for ${module} signing moduke`);
      }

      const kmsSigner = new KmsSigner({
        keyId: config.awsKmsSignerKeyId,
        region: config.awsKmsSignerKeyRegion,
      });

      return kmsSigner.getAccount();
    }

    default: {
      throw new Error(`Unsupported ${module} signing module`);
    }
  }
};

export const getSigningWallet = async (
  module: SigningModule = getSigningModule(),
): Promise<SigningWallet> => {
  if (!__cachedSigningWallet) {
    __cachedSigningWallet = createSigningWallet(module).catch(
      (error: unknown) => {
        // Allow transient initialization failures to be retried.
        __cachedSigningWallet = undefined;
        throw error;
      },
    );
  }

  return __cachedSigningWallet;
};

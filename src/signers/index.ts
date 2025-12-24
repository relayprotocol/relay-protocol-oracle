import { Account, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { KmsSigner } from "./aws-kms";
import { config } from "../config";

export type SigningModule = "raw-private-key" | "aws-kms";

export const getSigningWallet = async (
  module: SigningModule
): Promise<Account & Required<Pick<Account, "signMessage">>> => {
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

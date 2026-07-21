/**
 * For a detailed explanation regarding each configuration property, visit:
 * https://jestjs.io/docs/configuration
 */

import type { Config } from "jest";

const config: Config = {
  verbose: true,

  transform: {
    "^.+\\.(t|j)s?$": "ts-jest",
  },

  transformIgnorePatterns: [
    "node_modules/(?!(@nktkas/hyperliquid|@noble|@xrplf|@scure|ripple-address-codec|ripple-binary-codec)/)",
  ],

  // globalSetup: "./test/setup.ts",
};

export default config;

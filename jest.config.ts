/**
 * For a detailed explanation regarding each configuration property, visit:
 * https://jestjs.io/docs/configuration
 */

import type { Config } from "jest";

const config: Config = {
  verbose: true,

  transformIgnorePatterns: ["node_modules/(?!(@nktkas/hyperliquid|@noble)/)"],

  // globalSetup: "./test/setup.ts",
};

export default config;

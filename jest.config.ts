/**
 * For a detailed explanation regarding each configuration property, visit:
 * https://jestjs.io/docs/configuration
 */

import type { Config } from "jest";

const config: Config = {
  verbose: true,

  transform: {
    "^.+\\.ts?$": "ts-jest",
  },

  transformIgnorePatterns: ["node_modules/(?!(@noble)/)"],

  // globalSetup: "./test/setup.ts",
};

export default config;

import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as networks from "@relay-protocol/networks";
const configsDir = path.join(__dirname, "../../../src/configs");

const CONFIG_FILES = [
  "chains.hub.dev.json",
  "chains.hub.prod.json",
  "chains.mainnets.dev.json",
  "chains.mainnets.prod.json",
];

const testData = CONFIG_FILES.map((jsonFile) => {
  const tsFile = jsonFile.replace(".json", ".ts");
  const tsPath = path.join(configsDir, tsFile);
  const tsData = require(tsPath);

  const jsonPath = path.join(configsDir, "deprec", jsonFile);
  const jsonData = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  return { jsonFile, tsFile, tsData, jsonData };
});

describe("Chains config", () => {
  testData.forEach(({ jsonFile, tsFile, tsData, jsonData }) => {
    describe(`${jsonFile}`, () => {
      it(`all chains in ${jsonFile} are present in ${tsFile}`, () => {
        jsonData
          .sort((a: any, b: any) => b.id - a.id)
          .forEach((networkInfo: any) => {
            const tsInfo = tsData.find(
              (item: any) => item.id === networkInfo.id
            );
            expect(tsInfo).toBeDefined();
            Object.keys(networkInfo).forEach((key) => {
              expect(tsInfo[key]).toEqual(networkInfo[key]);
            });
          });
      });

      it(`no extra chains in ${tsFile} are present in ${tsFile}`, () => {
        const jsonChainIds = jsonData.map((c: any) => c.id);
        const tsChainIds = tsData.map((c: any) => c.id);
        tsChainIds.forEach((id: any) => expect(jsonChainIds).toContain(id));
      });
    });
  });
});

describe("Networks package", () => {
  const networksIds = Object.values(networks).map(
    (network: any) => network.slug
  );
  testData.forEach(({ jsonFile, tsFile, tsData, jsonData }) => {
    it(`all chains from ${jsonFile} are exported in networks package`, () => {
      const jsonChainIds = jsonData.map((c: any) => c.id);
      jsonChainIds.forEach((id: any) => expect(networksIds).toContain(id));
    });
    it(`all chains from ${tsFile} are exported in networks package`, () => {
      const tsChainIds = tsData.map((c: any) => c.id);
      tsChainIds.forEach((id: any) => expect(networksIds).toContain(id));
    });
  });
});

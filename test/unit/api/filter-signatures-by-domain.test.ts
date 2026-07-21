import { describe, expect, it } from "@jest/globals";

import { filterSignaturesByDomain } from "../../../src/api/utils";

const OLD_ORACLE = "0xd4b9fdb83c723c096d7fbe72da252aa23f1387aa";
const NEW_ORACLE = "0xCBA1cb9D0198Dd237619430EAe6Fe710cB91258D";

const oracleSig = (oracleContract: string, oracleChainId = "1337") => ({
  oracleChainId,
  oracleContract,
  oracleSigner: "0x1111111111111111111111111111111111111111",
  signature: "0xdeadbeef",
});

const oracleFields = {
  chainId: "oracleChainId",
  contract: "oracleContract",
};

describe("filterSignaturesByDomain", () => {
  it("keeps only peer signatures bound to the same contract (case-insensitive)", () => {
    const local = oracleSig(NEW_ORACLE);
    const peers = [
      oracleSig(NEW_ORACLE.toLowerCase()), // same contract, different casing
      oracleSig(OLD_ORACLE), // stale oracle → must be dropped
    ];

    const result = filterSignaturesByDomain(peers, local, oracleFields);

    expect(result).toHaveLength(1);
    expect(result[0].oracleContract).toBe(NEW_ORACLE.toLowerCase());
  });

  it("drops peer signatures on a different chain id even if the contract matches", () => {
    const local = oracleSig(NEW_ORACLE, "1337");
    const peers = [oracleSig(NEW_ORACLE, "42161")];

    expect(filterSignaturesByDomain(peers, local, oracleFields)).toEqual([]);
  });

  it("drops ALL peers during an oracle migration where they still sign the old address", () => {
    // Mirrors the split-brain migration: our node signs the new oracle, the
    // remaining peers still attest with the old oracle address.
    const local = oracleSig(NEW_ORACLE);
    const peers = [oracleSig(OLD_ORACLE), oracleSig(OLD_ORACLE)];

    expect(filterSignaturesByDomain(peers, local, oracleFields)).toEqual([]);
  });

  it("returns [] when the reference has no contract field", () => {
    const peers = [oracleSig(NEW_ORACLE)];

    expect(
      filterSignaturesByDomain(peers, { oracleChainId: "1337" }, oracleFields),
    ).toEqual([]);
  });

  it("handles undefined / empty peer signatures", () => {
    const local = oracleSig(NEW_ORACLE);

    expect(filterSignaturesByDomain(undefined, local, oracleFields)).toEqual(
      [],
    );
    expect(filterSignaturesByDomain([], local, oracleFields)).toEqual([]);
  });

  it("skips malformed peer signatures without a string contract", () => {
    const local = oracleSig(NEW_ORACLE);
    const peers = [
      { oracleChainId: "1337", oracleContract: undefined },
      { oracleChainId: "1337", oracleContract: 123 },
      oracleSig(NEW_ORACLE),
    ];

    const result = filterSignaturesByDomain(peers, local, oracleFields);

    expect(result).toHaveLength(1);
    expect(result[0].oracleContract).toBe(NEW_ORACLE);
  });

  it("works for non-oracle domains (e.g. generic-mapping contract fields)", () => {
    const fields = {
      chainId: "genericMappingChainId",
      contract: "genericMappingContract",
    };
    const local = {
      genericMappingChainId: 1n,
      genericMappingContract: NEW_ORACLE,
    };
    const peers = [
      { genericMappingChainId: "1", genericMappingContract: NEW_ORACLE },
      { genericMappingChainId: 1n, genericMappingContract: OLD_ORACLE },
    ];

    const result = filterSignaturesByDomain(peers, local, fields);

    expect(result).toHaveLength(1);
    expect(result[0].genericMappingContract).toBe(NEW_ORACLE);
  });
});

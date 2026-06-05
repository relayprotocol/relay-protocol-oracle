import { describe, expect, it } from "@jest/globals";

import { cartesianProduct } from "../../../../src/services/attestation/utils";

describe("cartesianProduct", () => {
  it("returns a single empty combination for no lists", () => {
    expect(cartesianProduct([])).toEqual([[]]);
  });

  it("returns one combination when every slot has a single option", () => {
    expect(cartesianProduct([["a"], ["b"], ["c"]])).toEqual([["a", "b", "c"]]);
  });

  it("expands a single re-signed slot into two combinations", () => {
    // One input signed twice (b1, b2) -> two candidate combinations.
    expect(cartesianProduct([["a"], ["b1", "b2"]])).toEqual([
      ["a", "b1"],
      ["a", "b2"],
    ]);
  });

  it("produces the product of all slot sizes", () => {
    // Two inputs each signed twice -> 2 * 2 = 4 combinations.
    const combinations = cartesianProduct([
      ["a1", "a2"],
      ["b1", "b2"],
    ]);
    expect(combinations).toHaveLength(4);
    expect(combinations).toEqual([
      ["a1", "b1"],
      ["a1", "b2"],
      ["a2", "b1"],
      ["a2", "b2"],
    ]);
  });

  it("collapses to no combinations when any slot is empty", () => {
    expect(cartesianProduct([["a"], []])).toEqual([]);
  });
});

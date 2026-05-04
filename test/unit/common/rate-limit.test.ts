import { describe, expect, it } from "@jest/globals";

import { createFixedWindowRateLimiter } from "../../../src/common/rate-limit";

describe("createFixedWindowRateLimiter", () => {
  it("allows requests until the configured limit is reached", () => {
    let now = 1000;
    const rateLimiter = createFixedWindowRateLimiter({
      max: 2,
      windowMs: 1000,
      now: () => now,
    });

    expect(rateLimiter.check("127.0.0.1")).toMatchObject({
      allowed: true,
      remaining: 1,
      resetMs: 1000,
    });
    expect(rateLimiter.check("127.0.0.1")).toMatchObject({
      allowed: true,
      remaining: 0,
      resetMs: 1000,
    });
    expect(rateLimiter.check("127.0.0.1")).toMatchObject({
      allowed: false,
      remaining: 0,
      resetMs: 1000,
    });

    now += 1001;

    expect(rateLimiter.check("127.0.0.1")).toMatchObject({
      allowed: true,
      remaining: 1,
      resetMs: 1000,
    });
  });

  it("tracks clients independently", () => {
    const rateLimiter = createFixedWindowRateLimiter({
      max: 1,
      windowMs: 60000,
      now: () => 1000,
    });

    expect(rateLimiter.check("127.0.0.1").allowed).toBe(true);
    expect(rateLimiter.check("127.0.0.1").allowed).toBe(false);
    expect(rateLimiter.check("127.0.0.2").allowed).toBe(true);
  });
});

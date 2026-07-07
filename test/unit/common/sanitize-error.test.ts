import { describe, expect, it } from "@jest/globals";
import { AxiosError, AxiosHeaders } from "axios";

import { sanitizeError } from "../../../src/common/sanitize-error";

describe("sanitizeError", () => {
  it("redacts request headers", () => {
    const error = new AxiosError(
      "Request failed with status code 429",
      "ERR_BAD_REQUEST",
      {
        url: "https://enterprise.blockstream.info/tx/abc/outspend/0",
        method: "get",
        headers: new AxiosHeaders({
          Authorization: "Bearer my-secret-token",
          "api-key": "my-secret-key",
        }),
      },
    );

    expect(JSON.stringify(error)).toContain("my-secret-token");

    const serialized = JSON.stringify(sanitizeError(error));

    expect(serialized).not.toContain("my-secret-token");
    expect(serialized).not.toContain("my-secret-key");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("/tx/abc/outspend/0");
  });

  it("redacts basic-auth credentials", () => {
    const error = new AxiosError("fail", "ERR_BAD_REQUEST", {
      url: "https://example.com",
      headers: new AxiosHeaders(),
      auth: { username: "user", password: "secret123" },
    });

    const serialized = JSON.stringify(sanitizeError(error));

    expect(serialized).not.toContain("secret123");
    expect(serialized).toContain("[REDACTED]");
  });

  it("redacts query-string credentials from the URL", () => {
    const error = new AxiosError("fail", "ERR_BAD_REQUEST", {
      url: "https://mainnet.helius-rpc.com/tx/abc?api-key=helius-secret-key&commitment=finalized&Token=token-secret",
      headers: new AxiosHeaders(),
    });

    const serialized = JSON.stringify(sanitizeError(error));

    expect(serialized).not.toContain("helius-secret-key");
    expect(serialized).toContain("helius-rpc.com");
    expect(serialized).toContain("/tx/abc");
    expect(serialized).not.toContain("token-secret");
    expect(serialized).toContain("commitment=finalized");
  });

  it("redacts userinfo credentials from the URL", () => {
    const error = new AxiosError("fail", "ERR_BAD_REQUEST", {
      url: "https://alice:secret123@rpc.example.com/v1",
      headers: new AxiosHeaders(),
    });

    const serialized = JSON.stringify(sanitizeError(error));

    expect(serialized).not.toContain("secret123");
    expect(serialized).not.toContain("alice");
    expect(serialized).toContain("rpc.example.com");
  });

  it("redacts query-string credentials from baseURL", () => {
    const error = new AxiosError("fail", "ERR_BAD_REQUEST", {
      baseURL: "https://rpc.example.com/?key=base-secret-key&network=ethereum",
      url: "/",
      headers: new AxiosHeaders(),
    });

    const serialized = JSON.stringify(sanitizeError(error));

    expect(serialized).not.toContain("base-secret-key");
    expect(serialized).toContain("rpc.example.com");
    expect(serialized).toContain("network=ethereum");
  });

  it("returns regular errors unchanged", () => {
    const error = new Error("fail");
    expect(sanitizeError(error)).toBe(error);
  });
});

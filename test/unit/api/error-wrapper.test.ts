import { describe, expect, it, jest } from "@jest/globals";
import { AxiosError, AxiosHeaders } from "axios";
import type { FastifyReply, FastifyRequest } from "fastify";

import { errorWrapper } from "../../../src/api/utils";
import { logger } from "../../../src/common/logger";

describe("errorWrapper", () => {
  it("redacts axios request headers from the logged error", async () => {
    const errorSpy = jest
      .spyOn(logger, "error")
      .mockImplementation((() => { }) as never);

    const axiosError = new AxiosError(
      "Request failed with status code 429",
      "ERR_BAD_REQUEST",
      {
        url: "https://gomaestro-api.io/mainnet/tx/abc/outspend/0",
        method: "get",
        headers: new AxiosHeaders({ "api-key": "my-secret-key" }),
      },
    );

    const wrapped = errorWrapper("/test", async () => {
      throw axiosError;
    });

    await expect(
      wrapped({ url: "/test" } as FastifyRequest, {} as FastifyReply),
    ).rejects.toThrow("Something went wrong");

    const logged = errorSpy.mock.calls.map((call) => call[1]).join("\n");
    expect(logged).not.toContain("my-secret-key");
    expect(logged).toContain("[REDACTED]");

    errorSpy.mockRestore();
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setDbExecutorForTests } from "@/lib/db";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  UTTR_FORCE_DURABLE_RATE_LIMITS: process.env.UTTR_FORCE_DURABLE_RATE_LIMITS,
};

function restoreEnv(name: keyof typeof originalEnv) {
  const value = originalEnv[name];
  if (typeof value === "string") {
    process.env[name] = value;
    return;
  }

  delete process.env[name];
}

const { POST } = await import("./route");

beforeEach(() => {
  process.env.UTTR_FORCE_DURABLE_RATE_LIMITS = "true";
});

afterEach(() => {
  setDbExecutorForTests(null);
  restoreEnv("NODE_ENV");
  restoreEnv("UTTR_FORCE_DURABLE_RATE_LIMITS");
});

function buildThrowingRequest() {
  const request = new Request("https://uttr.test/api/checkout", {
    method: "POST",
    headers: {
      "x-forwarded-for": "203.0.113.20, 10.0.0.1",
    },
  });

  Object.defineProperty(request, "json", {
    configurable: true,
    value: async () => {
      throw new Error("request body should not be read while rate limited");
    },
  });

  return request;
}

describe("/api/checkout rate limiting", () => {
  test("returns 429 before reading checkout payload when exhausted", async () => {
    setDbExecutorForTests({
      async query(_sql, values) {
        expect(values).toEqual(["checkout:203.0.113.20", 60_000]);
        return {
          rows: [{ count: 21, reset_at: new Date(Date.now() + 6_000) }],
          rowCount: 1,
        };
      },
    });

    const response = await POST(buildThrowingRequest());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("6");
    await expect(response.json()).resolves.toEqual({
      error: "Too many checkout requests.",
    });
  });
});

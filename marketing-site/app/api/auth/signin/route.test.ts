import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setDbExecutorForTests } from "@/lib/db";
import { POST } from "./route";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
};

function restoreEnv(name: keyof typeof originalEnv) {
  const value = originalEnv[name];
  if (typeof value === "string") {
    process.env[name] = value;
    return;
  }

  delete process.env[name];
}

beforeEach(() => {
  process.env.NODE_ENV = "production";
});

afterEach(() => {
  setDbExecutorForTests(null);
  restoreEnv("NODE_ENV");
});

function buildThrowingRequest() {
  const request = new Request("https://uttr.test/api/auth/signin", {
    method: "POST",
    headers: {
      "x-forwarded-for": "203.0.113.5, 10.0.0.1",
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

describe("/api/auth/signin rate limiting", () => {
  test("returns 429 before reading credentials when the route is exhausted", async () => {
    setDbExecutorForTests({
      async query(_sql, values) {
        expect(values).toEqual(["account-signin:203.0.113.5", 60_000]);
        return {
          rows: [{ count: 11, reset_at: new Date(Date.now() + 8_000) }],
          rowCount: 1,
        };
      },
    });

    const response = await POST(buildThrowingRequest());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("8");
    await expect(response.json()).resolves.toEqual({
      error: "Too many sign-in attempts.",
    });
  });

  test("fails closed when durable rate limiting is unavailable", async () => {
    setDbExecutorForTests({
      async query() {
        throw new Error("durable rate limit store unavailable");
      },
    });

    const response = await POST(buildThrowingRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    await expect(response.json()).resolves.toEqual({
      error: "Rate limiting is temporarily unavailable.",
    });
  });
});

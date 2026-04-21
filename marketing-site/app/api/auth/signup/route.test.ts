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
  const request = new Request("https://uttr.test/api/auth/signup", {
    method: "POST",
    headers: {
      "x-forwarded-for": "203.0.113.6, 10.0.0.1",
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

describe("/api/auth/signup rate limiting", () => {
  test("returns 429 before reading credentials when the route is exhausted", async () => {
    setDbExecutorForTests({
      async query(_sql, values) {
        expect(values).toEqual(["account-signup:203.0.113.6", 60_000]);
        return {
          rows: [{ count: 6, reset_at: new Date(Date.now() + 7_000) }],
          rowCount: 1,
        };
      },
    });

    const response = await POST(buildThrowingRequest());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    await expect(response.json()).resolves.toEqual({
      error: "Too many account creation attempts.",
    });
  });
});

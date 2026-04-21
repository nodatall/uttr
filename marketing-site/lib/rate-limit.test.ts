import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  checkRateLimit,
  rateLimitKeyFromRequest,
  resetRateLimitForTests,
} from "./rate-limit";
import { setDbExecutorForTests } from "./db";

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
  process.env.NODE_ENV = "test";
});

afterEach(() => {
  resetRateLimitForTests();
  setDbExecutorForTests(null);
  restoreEnv("NODE_ENV");
});

describe("rate limiting", () => {
  test("allows requests until the limit is reached in memory mode", async () => {
    const policy = { key: "route:ip", limit: 2, windowMs: 60_000 };

    await expect(checkRateLimit(policy, 1_000)).resolves.toEqual({
      allowed: true,
      remaining: 1,
      source: "memory",
    });
    await expect(checkRateLimit(policy, 2_000)).resolves.toEqual({
      allowed: true,
      remaining: 0,
      source: "memory",
    });
    await expect(checkRateLimit(policy, 3_000)).resolves.toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 58,
      source: "memory",
    });
  });

  test("resets after the window", async () => {
    const policy = { key: "route:ip", limit: 1, windowMs: 10_000 };

    await expect(checkRateLimit(policy, 1_000)).resolves.toMatchObject({
      allowed: true,
      source: "memory",
    });
    await expect(checkRateLimit(policy, 2_000)).resolves.toMatchObject({
      allowed: false,
      source: "memory",
    });
    await expect(checkRateLimit(policy, 12_000)).resolves.toEqual({
      allowed: true,
      remaining: 0,
      source: "memory",
    });
  });

  test("builds keys from forwarded ip", () => {
    const request = new Request("https://uttr.test/api/trial/bootstrap", {
      headers: { "x-forwarded-for": "203.0.113.2, 10.0.0.1" },
    });

    expect(rateLimitKeyFromRequest(request, "bootstrap")).toBe(
      "bootstrap:203.0.113.2",
    );
  });

  test("uses durable storage in production and surfaces retry-after values", async () => {
    process.env.NODE_ENV = "production";
    const resetAt = new Date(Date.now() + 17_000).toISOString();
    let queryValues: readonly unknown[] | undefined;

    setDbExecutorForTests({
      async query(_sql, values) {
        queryValues = values;
        return {
          rows: [{ count: 21, reset_at: resetAt }],
          rowCount: 1,
        };
      },
    });

    await expect(
      checkRateLimit({
        key: "trial-create-claim:ip",
        limit: 20,
        windowMs: 60_000,
      }),
    ).resolves.toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 17,
      source: "durable",
    });

    expect(queryValues).toEqual(["trial-create-claim:ip", 60_000]);
  });

  test("fails closed in production when durable storage is unavailable", async () => {
    process.env.NODE_ENV = "production";
    setDbExecutorForTests({
      async query() {
        throw new Error("database unavailable");
      },
    });

    await expect(
      checkRateLimit({
        key: "cloud-transcribe:ip",
        limit: 60,
        windowMs: 60_000,
      }),
    ).resolves.toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 60,
      source: "unavailable",
    });
  });
});

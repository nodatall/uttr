import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  checkRateLimit,
  rateLimitKeyFromRequest,
  resetRateLimitForTests,
} from "./rate-limit";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

const originalFetch = globalThis.fetch;

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
  process.env.SUPABASE_URL = "https://supabase.test";
  process.env.SUPABASE_ANON_KEY = "anon-key-test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  resetRateLimitForTests();
  restoreEnv("NODE_ENV");
  restoreEnv("SUPABASE_URL");
  restoreEnv("SUPABASE_ANON_KEY");
  restoreEnv("SUPABASE_SERVICE_ROLE_KEY");
  globalThis.fetch = originalFetch;
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
    let requestBody = "";
    globalThis.fetch = async (input, init) => {
      expect(String(input)).toContain("/rest/v1/rpc/consume_rate_limit");
      requestBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify([
          {
            allowed: false,
            remaining: 0,
            retry_after_seconds: 17,
          },
        ]),
        { status: 200 },
      );
    };

    await expect(
      checkRateLimit({ key: "trial-create-claim:ip", limit: 20, windowMs: 60_000 }),
    ).resolves.toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 17,
      source: "durable",
    });

    expect(JSON.parse(requestBody)).toEqual({
      p_rate_limit_key: "trial-create-claim:ip",
      p_limit: 20,
      p_window_ms: 60_000,
    });
  });

  test("fails closed in production when durable storage is unavailable", async () => {
    process.env.NODE_ENV = "production";
    globalThis.fetch = async () => {
      throw new Error("supabase unavailable");
    };

    await expect(
      checkRateLimit({ key: "cloud-transcribe:ip", limit: 60, windowMs: 60_000 }),
    ).resolves.toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 60,
      source: "unavailable",
    });
  });
});

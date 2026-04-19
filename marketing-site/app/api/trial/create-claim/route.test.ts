import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { POST } from "./route";

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
  process.env.NODE_ENV = "production";
  process.env.SUPABASE_URL = "https://supabase.test";
  process.env.SUPABASE_ANON_KEY = "anon-key-test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  restoreEnv("NODE_ENV");
  restoreEnv("SUPABASE_URL");
  restoreEnv("SUPABASE_ANON_KEY");
  restoreEnv("SUPABASE_SERVICE_ROLE_KEY");
  globalThis.fetch = originalFetch;
});

function buildThrowingRequest() {
  const request = new Request("https://uttr.test/api/trial/create-claim", {
    method: "POST",
    headers: {
      "x-forwarded-for": "203.0.113.2, 10.0.0.1",
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

describe("/api/trial/create-claim rate limiting", () => {
  test("returns 429 for normal exhaustion without reading the body", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify([
          {
            allowed: false,
            remaining: 0,
            retry_after_seconds: 9,
          },
        ]),
        { status: 200 },
      );

    const response = await POST(buildThrowingRequest());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("9");
    await expect(response.json()).resolves.toEqual({
      error: "Too many claim requests.",
    });
  });

  test("returns a conservative retryable error when durable storage is unavailable", async () => {
    globalThis.fetch = async () => {
      throw new Error("durable rate limit store unavailable");
    };

    const response = await POST(buildThrowingRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    await expect(response.json()).resolves.toEqual({
      error: "Rate limiting is temporarily unavailable.",
    });
  });
});

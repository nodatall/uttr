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
    setDbExecutorForTests({
      async query() {
        return {
          rows: [{ count: 21, reset_at: new Date(Date.now() + 9_000) }],
          rowCount: 1,
        };
      },
    });

    const response = await POST(buildThrowingRequest());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("9");
    await expect(response.json()).resolves.toEqual({
      error: "Too many claim requests.",
    });
  });

  test("returns a conservative retryable error when durable storage is unavailable", async () => {
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

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

describe("/api/billing/portal rate limiting", () => {
  test("returns 429 before session lookup when exhausted", async () => {
    setDbExecutorForTests({
      async query(_sql, values) {
        expect(values).toEqual(["billing-portal:203.0.113.21", 60_000]);
        return {
          rows: [{ count: 21, reset_at: new Date(Date.now() + 5_000) }],
          rowCount: 1,
        };
      },
    });

    const response = await POST(
      new Request("https://uttr.test/api/billing/portal", {
        method: "POST",
        headers: {
          "x-forwarded-for": "203.0.113.21, 10.0.0.1",
        },
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("5");
    await expect(response.json()).resolves.toEqual({
      error: "Too many billing portal requests.",
    });
  });
});

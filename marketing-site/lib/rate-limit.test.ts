import { afterEach, describe, expect, test } from "bun:test";
import {
  checkRateLimit,
  rateLimitKeyFromRequest,
  resetRateLimitForTests,
} from "./rate-limit";

afterEach(() => {
  resetRateLimitForTests();
});

describe("rate limiting", () => {
  test("allows requests until the limit is reached", () => {
    const policy = { key: "route:ip", limit: 2, windowMs: 60_000 };

    expect(checkRateLimit(policy, 1_000)).toEqual({
      allowed: true,
      remaining: 1,
    });
    expect(checkRateLimit(policy, 2_000)).toEqual({
      allowed: true,
      remaining: 0,
    });
    expect(checkRateLimit(policy, 3_000)).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 58,
    });
  });

  test("resets after the window", () => {
    const policy = { key: "route:ip", limit: 1, windowMs: 10_000 };

    expect(checkRateLimit(policy, 1_000).allowed).toBe(true);
    expect(checkRateLimit(policy, 2_000).allowed).toBe(false);
    expect(checkRateLimit(policy, 12_000)).toEqual({
      allowed: true,
      remaining: 0,
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
});

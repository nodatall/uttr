import { describe, expect, test } from "bun:test";
import { buildTimings } from "./timings";

describe("proxy timings", () => {
  test("derives the expected telemetry buckets", () => {
    expect(buildTimings(10, 30, 80, 120)).toEqual({
      total_ms: 110,
      preflight_ms: 20,
      groq_ms: 50,
      persistence_ms: 40,
      backend_overhead_ms: 60,
    });
  });
});

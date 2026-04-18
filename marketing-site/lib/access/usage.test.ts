import { describe, expect, test } from "bun:test";
import {
  summarizeUsageEvents,
  trialUsageAllowsRequest,
  TRIAL_USAGE_AUDIO_SECONDS_LIMIT,
  TRIAL_USAGE_REQUEST_LIMIT,
} from "./usage";
import type { UsageEventRow } from "./types";

function usage(audioSeconds: number): UsageEventRow {
  return {
    id: crypto.randomUUID(),
    anonymous_trial_id: "trial_123",
    user_id: null,
    source: "cloud_default",
    audio_seconds: audioSeconds,
    created_at: new Date().toISOString(),
  };
}

describe("trial usage quota", () => {
  test("summarizes usage event count and seconds", () => {
    expect(summarizeUsageEvents([usage(10), usage(15)])).toEqual({
      requestCount: 2,
      audioSeconds: 25,
    });
  });

  test("blocks when request count is exhausted", () => {
    const events = Array.from({ length: TRIAL_USAGE_REQUEST_LIMIT }, () =>
      usage(1),
    );

    expect(trialUsageAllowsRequest(events, 1)).toMatchObject({
      allowed: false,
      reason: "request_limit",
    });
  });

  test("blocks when incoming audio exceeds remaining seconds", () => {
    const events = [usage(TRIAL_USAGE_AUDIO_SECONDS_LIMIT - 5)];

    expect(trialUsageAllowsRequest(events, 6)).toMatchObject({
      allowed: false,
      reason: "audio_seconds_limit",
    });
  });
});

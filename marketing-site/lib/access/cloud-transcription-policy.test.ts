import { describe, expect, test } from "bun:test";
import { evaluateCloudTranscriptionPreflight } from "./cloud-transcription-policy";
import {
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

describe("cloud transcription pre-provider policy", () => {
  test("blocks expired unpaid access before provider transcription", () => {
    expect(
      evaluateCloudTranscriptionPreflight({
        accessState: "blocked",
        trialState: "expired",
        source: "file_transcription",
        usageEvents: [],
        audioSeconds: 30,
      }),
    ).toMatchObject({
      allowed: false,
      status: 403,
      error: "Upgrade to Pro to keep using transcription.",
    });
  });

  test("blocks exhausted trial usage before provider transcription", () => {
    const usageEvents = Array.from({ length: TRIAL_USAGE_REQUEST_LIMIT }, () =>
      usage(1),
    );

    expect(
      evaluateCloudTranscriptionPreflight({
        accessState: "trialing",
        trialState: "trialing",
        source: "file_transcription",
        usageEvents,
        audioSeconds: 1,
      }),
    ).toMatchObject({
      allowed: false,
      status: 403,
      reason: "request_limit",
    });
  });

  test("allows subscribed access regardless of trial usage counters", () => {
    expect(
      evaluateCloudTranscriptionPreflight({
        accessState: "subscribed",
        trialState: "linked",
        source: "file_transcription",
        usageEvents: [usage(TRIAL_USAGE_AUDIO_SECONDS_LIMIT)],
        audioSeconds: TRIAL_USAGE_AUDIO_SECONDS_LIMIT,
      }),
    ).toEqual({ allowed: true });
  });
});

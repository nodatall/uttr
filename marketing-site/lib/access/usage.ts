import type { UsageEventRow } from "./types";

export const TRIAL_USAGE_AUDIO_SECONDS_LIMIT = 2 * 60 * 60;
export const TRIAL_USAGE_REQUEST_LIMIT = 250;

export function summarizeUsageEvents(events: UsageEventRow[]) {
  return {
    requestCount: events.length,
    audioSeconds: events.reduce(
      (total, event) => total + Math.max(0, event.audio_seconds || 0),
      0,
    ),
  };
}

export function trialUsageAllowsRequest(
  events: UsageEventRow[],
  incomingAudioSeconds: number,
) {
  const summary = summarizeUsageEvents(events);

  if (summary.requestCount >= TRIAL_USAGE_REQUEST_LIMIT) {
    return {
      allowed: false,
      reason: "request_limit" as const,
      summary,
    };
  }

  if (
    summary.audioSeconds + Math.max(0, incomingAudioSeconds) >
    TRIAL_USAGE_AUDIO_SECONDS_LIMIT
  ) {
    return {
      allowed: false,
      reason: "audio_seconds_limit" as const,
      summary,
    };
  }

  return {
    allowed: true,
    reason: null,
    summary,
  };
}

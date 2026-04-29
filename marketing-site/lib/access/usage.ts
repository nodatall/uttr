import type { UsageEventRow } from "./types";

export const TRIAL_USAGE_AUDIO_SECONDS_LIMIT = 2 * 60 * 60;
export const TRIAL_USAGE_REQUEST_LIMIT = 250;
export const PRO_USAGE_DAILY_AUDIO_SECONDS_LIMIT_DEFAULT = 5 * 60 * 60;
export const PRO_USAGE_DAILY_REQUEST_LIMIT_DEFAULT = 500;
export const PRO_USAGE_BURST_REQUEST_LIMIT_DEFAULT = 60;
export const PRO_USAGE_BURST_WINDOW_SECONDS_DEFAULT = 10 * 60;

export type UsageLimitReason = "request_limit" | "audio_seconds_limit";

export type UsageLimitDecision =
  | {
      allowed: true;
      reason: null;
      summary: ReturnType<typeof summarizeUsageEvents>;
    }
  | {
      allowed: false;
      reason: UsageLimitReason;
      summary: ReturnType<typeof summarizeUsageEvents>;
    };

export type ProUsageLimits = {
  dailyAudioSecondsLimit: number;
  dailyRequestLimit: number;
  burstRequestLimit: number;
  burstWindowSeconds: number;
};

export function summarizeUsageEvents(events: UsageEventRow[]) {
  return {
    requestCount: events.length,
    audioSeconds: events.reduce(
      (total, event) => total + Math.max(0, event.audio_seconds || 0),
      0,
    ),
  };
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const rawValue = process.env[name];
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readProUsageLimits(): ProUsageLimits {
  return {
    dailyAudioSecondsLimit: readPositiveIntegerEnv(
      "UTTR_PRO_DAILY_AUDIO_SECONDS_LIMIT",
      PRO_USAGE_DAILY_AUDIO_SECONDS_LIMIT_DEFAULT,
    ),
    dailyRequestLimit: readPositiveIntegerEnv(
      "UTTR_PRO_DAILY_REQUEST_LIMIT",
      PRO_USAGE_DAILY_REQUEST_LIMIT_DEFAULT,
    ),
    burstRequestLimit: readPositiveIntegerEnv(
      "UTTR_PRO_BURST_REQUEST_LIMIT",
      PRO_USAGE_BURST_REQUEST_LIMIT_DEFAULT,
    ),
    burstWindowSeconds: readPositiveIntegerEnv(
      "UTTR_PRO_BURST_WINDOW_SECONDS",
      PRO_USAGE_BURST_WINDOW_SECONDS_DEFAULT,
    ),
  };
}

function usageAllowsRequest(
  events: UsageEventRow[],
  incomingAudioSeconds: number,
  limits: {
    requestLimit: number;
    audioSecondsLimit?: number;
  },
): UsageLimitDecision {
  const summary = summarizeUsageEvents(events);

  if (summary.requestCount >= limits.requestLimit) {
    return {
      allowed: false,
      reason: "request_limit" as const,
      summary,
    };
  }

  if (
    limits.audioSecondsLimit !== undefined &&
    summary.audioSeconds + Math.max(0, incomingAudioSeconds) >
      limits.audioSecondsLimit
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

export function trialUsageAllowsRequest(
  events: UsageEventRow[],
  incomingAudioSeconds: number,
) {
  return usageAllowsRequest(events, incomingAudioSeconds, {
    requestLimit: TRIAL_USAGE_REQUEST_LIMIT,
    audioSecondsLimit: TRIAL_USAGE_AUDIO_SECONDS_LIMIT,
  });
}

export function proDailyUsageAllowsRequest(
  events: UsageEventRow[],
  incomingAudioSeconds: number,
  limits: ProUsageLimits,
) {
  return usageAllowsRequest(events, incomingAudioSeconds, {
    requestLimit: limits.dailyRequestLimit,
    audioSecondsLimit: limits.dailyAudioSecondsLimit,
  });
}

export function proBurstUsageAllowsRequest(
  events: UsageEventRow[],
  limits: ProUsageLimits,
) {
  return usageAllowsRequest(events, 0, {
    requestLimit: limits.burstRequestLimit,
  });
}

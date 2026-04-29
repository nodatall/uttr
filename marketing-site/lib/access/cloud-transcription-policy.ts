import { accessAllowsCloudSource } from "./premium-features";
import {
  proBurstUsageAllowsRequest,
  proDailyUsageAllowsRequest,
  readProUsageLimits,
  trialUsageAllowsRequest,
  type ProUsageLimits,
} from "./usage";
import type { AccessState, TrialState, UsageEventRow } from "./types";

type CloudTranscriptionPreflightParams = {
  accessState: AccessState;
  trialState: TrialState;
  source: string | null;
  usageEvents: UsageEventRow[];
  proDailyUsageEvents?: UsageEventRow[];
  proBurstUsageEvents?: UsageEventRow[];
  proUsageLimits?: ProUsageLimits;
  audioSeconds: number;
};

type CloudTranscriptionPreflightResult =
  | {
      allowed: true;
    }
  | {
      allowed: false;
      status: 403;
      error: string;
      reason?: "request_limit" | "audio_seconds_limit";
    };

export function evaluateCloudTranscriptionPreflight({
  accessState,
  trialState,
  source,
  usageEvents,
  proDailyUsageEvents = [],
  proBurstUsageEvents = [],
  proUsageLimits = readProUsageLimits(),
  audioSeconds,
}: CloudTranscriptionPreflightParams): CloudTranscriptionPreflightResult {
  if (!accessAllowsCloudSource(accessState, source, trialState)) {
    return {
      allowed: false,
      status: 403,
      error: "Upgrade to Pro to keep using transcription.",
    };
  }

  if (accessState === "subscribed") {
    const burstDecision = proBurstUsageAllowsRequest(
      proBurstUsageEvents,
      proUsageLimits,
    );
    if (!burstDecision.allowed) {
      return {
        allowed: false,
        status: 403,
        error:
          "Temporary Pro usage limit reached. Contact support if this is legitimate heavy use.",
        reason: burstDecision.reason,
      };
    }

    const dailyDecision = proDailyUsageAllowsRequest(
      proDailyUsageEvents,
      audioSeconds,
      proUsageLimits,
    );
    if (!dailyDecision.allowed) {
      return {
        allowed: false,
        status: 403,
        error:
          "Daily Pro usage limit reached. Contact support if this is legitimate heavy use.",
        reason: dailyDecision.reason,
      };
    }

    return { allowed: true };
  }

  const usageDecision = trialUsageAllowsRequest(usageEvents, audioSeconds);
  if (!usageDecision.allowed) {
    return {
      allowed: false,
      status: 403,
      error: "Trial usage limit reached. Upgrade to Pro to continue.",
      reason: usageDecision.reason ?? undefined,
    };
  }

  return { allowed: true };
}

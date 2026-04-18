import { accessAllowsCloudSource } from "./premium-features";
import { trialUsageAllowsRequest } from "./usage";
import type { AccessState, TrialState, UsageEventRow } from "./types";

type CloudTranscriptionPreflightParams = {
  accessState: AccessState;
  trialState: TrialState;
  source: string | null;
  usageEvents: UsageEventRow[];
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

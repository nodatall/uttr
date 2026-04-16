import type { AccessState, TrialState } from "./types";

const PREMIUM_CLOUD_SOURCES = new Set([
  "file_transcription",
  "full_system_audio",
]);

function normalizeSource(source: string | null | undefined) {
  const normalized = source?.trim().toLowerCase();
  return normalized ? normalized : null;
}

export function sourceRequiresPremiumCloudAccess(
  source: string | null | undefined,
) {
  const normalized = normalizeSource(source);
  return normalized ? PREMIUM_CLOUD_SOURCES.has(normalized) : false;
}

export function accessAllowsCloudSource(
  accessState: AccessState,
  source: string | null | undefined,
  trialState?: TrialState,
) {
  if (trialState === "new") {
    return true;
  }

  return accessState === "trialing" || accessState === "subscribed";
}

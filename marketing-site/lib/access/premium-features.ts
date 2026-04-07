import type { AccessState } from "./types";

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
) {
  if (!sourceRequiresPremiumCloudAccess(source)) {
    return true;
  }

  return accessState === "subscribed";
}

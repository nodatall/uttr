import type { AccessState, TrialState } from "./types";

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

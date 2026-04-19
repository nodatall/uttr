import type { AccessDecision, AnonymousTrialRow } from "./types";

export function trialCanCreateClaim(
  trial: AnonymousTrialRow,
  accessDecision: Pick<AccessDecision, "accessState">,
) {
  if (accessDecision.accessState === "subscribed") {
    return false;
  }

  if (trial.user_id) {
    return true;
  }

  return trial.status === "new" || trial.status === "trialing" || trial.status === "expired";
}

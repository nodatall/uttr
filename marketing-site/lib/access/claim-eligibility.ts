import type { AccessDecision, AnonymousTrialRow } from "./types";

export function trialCanCreateClaim(
  trial: AnonymousTrialRow,
  accessDecision: Pick<AccessDecision, "accessState">,
) {
  if (trial.user_id) {
    return false;
  }

  return (
    trial.status === "new" ||
    trial.status === "trialing" ||
    trial.status === "expired" ||
    accessDecision.accessState === "blocked"
  );
}

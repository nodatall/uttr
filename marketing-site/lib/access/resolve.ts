import type {
  AccessDecision,
  AnonymousTrialRow,
  EntitlementRow,
  TrialState,
} from "./types";
import { isAnonymousTrialExpired, patchAnonymousTrialById } from "./postgres";

export function normalizeTrialState(trial: AnonymousTrialRow): TrialState {
  if (trial.status === "trialing" && isAnonymousTrialExpired(trial)) {
    return "expired";
  }

  return trial.status;
}

export function resolveAccessDecision(
  trial: AnonymousTrialRow,
  entitlement: EntitlementRow | null,
): AccessDecision {
  const trialState = normalizeTrialState(trial);
  const entitlementState = entitlement?.subscription_status ?? "inactive";

  if (entitlementState === "active") {
    return {
      trialState,
      accessState: "subscribed",
      entitlementState,
    };
  }

  if (trialState === "trialing") {
    return {
      trialState,
      accessState: "trialing",
      entitlementState,
    };
  }

  return {
    trialState,
    accessState: "blocked",
    entitlementState,
  };
}

export async function refreshAnonymousTrialState(trial: AnonymousTrialRow) {
  if (!isAnonymousTrialExpired(trial)) {
    return trial;
  }

  return (
    (await patchAnonymousTrialById(trial.id, {
      status: "expired",
      last_seen_at: new Date().toISOString(),
    })) ?? trial
  );
}

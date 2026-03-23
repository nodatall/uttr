export const trialStates = ["new", "trialing", "expired", "linked"] as const;
export type TrialState = (typeof trialStates)[number];

export const accessStates = ["blocked", "trialing", "subscribed"] as const;
export type AccessState = (typeof accessStates)[number];

export const entitlementStates = [
  "inactive",
  "active",
  "past_due",
  "canceled",
  "expired",
] as const;
export type EntitlementState = (typeof entitlementStates)[number];

export interface AnonymousTrialRow {
  id: string;
  install_id: string;
  device_fingerprint_hash: string;
  user_id: string | null;
  status: TrialState;
  trial_started_at: string | null;
  trial_ends_at: string | null;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

export interface EntitlementRow {
  user_id: string;
  subscription_status: EntitlementState;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_ends_at: string | null;
  updated_at: string;
}

export interface InstallTokenPayload {
  version: 1;
  anonymous_trial_id: string;
  install_id: string;
  device_fingerprint_hash: string;
  issued_at: string;
}

export interface AccessDecision {
  trialState: TrialState;
  accessState: AccessState;
  entitlementState: EntitlementState;
}

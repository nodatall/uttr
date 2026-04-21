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

export const checkoutSessionStatuses = [
  "open",
  "completed",
  "expired",
] as const;
export type CheckoutSessionStatus = (typeof checkoutSessionStatuses)[number];

export const usageEventSources = [
  "cloud_default",
  "cloud_byok",
  "local_fallback",
] as const;
export type UsageEventSource = (typeof usageEventSources)[number];

export interface ClaimTokenPayload {
  version: 1;
  claim_id: string;
  anonymous_trial_id: string;
  install_id: string;
  issued_at: string;
  expires_at: string;
}

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

export interface TrialClaimRow {
  id: string;
  anonymous_trial_id: string;
  claim_token_hash: string;
  expires_at: string;
  redeemed_at: string | null;
  created_at: string;
}

export interface EntitlementRow {
  user_id: string;
  subscription_status: EntitlementState;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_ends_at: string | null;
  updated_at: string;
}

export interface CheckoutSessionRow {
  id: string;
  checkout_context_key: string;
  user_id: string;
  anonymous_trial_id: string | null;
  install_id: string | null;
  stripe_checkout_session_id: string;
  stripe_customer_id: string | null;
  status: CheckoutSessionStatus;
  checkout_url: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface InstallTokenPayload {
  version: 1;
  anonymous_trial_id: string;
  install_id: string;
  device_fingerprint_hash: string;
  issued_at: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string | null;
}

export interface AccessDecision {
  trialState: TrialState;
  accessState: AccessState;
  entitlementState: EntitlementState;
}

export interface UsageEventRow {
  id: string;
  anonymous_trial_id: string | null;
  user_id: string | null;
  source: UsageEventSource;
  audio_seconds: number;
  created_at: string;
}

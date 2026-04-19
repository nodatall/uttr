import { describe, expect, test } from "bun:test";
import { resolveClaimConversionOutcome } from "./claim-conversion";
import type {
  AnonymousTrialRow,
  ClaimTokenPayload,
  EntitlementRow,
  TrialClaimRow,
} from "./types";

function claim(overrides: Partial<TrialClaimRow> = {}): TrialClaimRow {
  const now = new Date().toISOString();
  return {
    id: "claim_123",
    anonymous_trial_id: "trial_123",
    claim_token_hash: "hash_123",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    redeemed_at: null,
    created_at: now,
    ...overrides,
  };
}

function trial(overrides: Partial<AnonymousTrialRow> = {}): AnonymousTrialRow {
  const now = new Date().toISOString();
  return {
    id: "trial_123",
    install_id: "install_123",
    device_fingerprint_hash: "fingerprint_123",
    user_id: null,
    status: "new",
    trial_started_at: null,
    trial_ends_at: null,
    last_seen_at: now,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function entitlement(
  overrides: Partial<EntitlementRow> = {},
): EntitlementRow {
  const now = new Date().toISOString();
  return {
    user_id: "user_123",
    subscription_status: "inactive",
    stripe_customer_id: null,
    stripe_subscription_id: null,
    current_period_ends_at: null,
    updated_at: now,
    ...overrides,
  };
}

function payload(
  overrides: Partial<ClaimTokenPayload> = {},
): ClaimTokenPayload {
  const now = new Date();
  return {
    version: 1,
    claim_id: "claim_123",
    anonymous_trial_id: "trial_123",
    install_id: "install_123",
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 60_000).toISOString(),
    ...overrides,
  };
}

describe("claim conversion outcome", () => {
  test("returns linked for a fresh unlinked conversion", () => {
    expect(
      resolveClaimConversionOutcome({
        currentUserId: "user_123",
        tokenPayload: payload(),
        claim: claim(),
        trial: trial(),
        entitlement: entitlement(),
      }),
    ).toEqual({
      status: "linked",
      checkout_safe: true,
      user_id: "user_123",
      has_active_entitlement: false,
    });
  });

  test("returns already_linked_same_user for same-user retry", () => {
    expect(
      resolveClaimConversionOutcome({
        currentUserId: "user_123",
        tokenPayload: payload(),
        claim: claim({ redeemed_at: new Date().toISOString() }),
        trial: trial({ user_id: "user_123" }),
        entitlement: entitlement({ subscription_status: "active" }),
      }),
    ).toEqual({
      status: "already_linked_same_user",
      checkout_safe: true,
      user_id: "user_123",
      has_active_entitlement: true,
    });
  });

  test("returns linked for a fresh token on an already-linked same-user install", () => {
    expect(
      resolveClaimConversionOutcome({
        currentUserId: "user_123",
        tokenPayload: payload(),
        claim: claim(),
        trial: trial({ user_id: "user_123", status: "linked" }),
        entitlement: entitlement(),
      }),
    ).toEqual({
      status: "linked",
      checkout_safe: true,
      user_id: "user_123",
      has_active_entitlement: false,
    });
  });

  test("returns already_linked_different_user for a wrong-user retry", () => {
    expect(
      resolveClaimConversionOutcome({
        currentUserId: "user_123",
        tokenPayload: payload(),
        claim: claim(),
        trial: trial({ user_id: "user_456" }),
        entitlement: entitlement(),
      }),
    ).toEqual({
      status: "already_linked_different_user",
      checkout_safe: false,
    });
  });

  test("returns expired_claim for expired tokens", () => {
    const expired = new Date(Date.now() - 60_000).toISOString();

    expect(
      resolveClaimConversionOutcome({
        currentUserId: "user_123",
        tokenPayload: payload({ expires_at: expired }),
        claim: claim({ expires_at: expired }),
        trial: trial(),
        entitlement: entitlement(),
      }),
    ).toEqual({
      status: "expired_claim",
      checkout_safe: false,
    });
  });

  test("returns invalid_claim when the stored claim does not match the token", () => {
    expect(
      resolveClaimConversionOutcome({
        currentUserId: "user_123",
        tokenPayload: payload({ claim_id: "claim_other" }),
        claim: claim(),
        trial: trial(),
        entitlement: entitlement(),
      }),
    ).toEqual({
      status: "invalid_claim",
      checkout_safe: false,
    });
  });
});

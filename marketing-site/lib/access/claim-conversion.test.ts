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

function entitlement(overrides: Partial<EntitlementRow> = {}): EntitlementRow {
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
  test("resolves supported fresh, retry, conflict, expiry, and invalid states", () => {
    const expired = new Date(Date.now() - 60_000).toISOString();
    const cases = [
      {
        name: "fresh unlinked conversion",
        input: {
          currentUserId: "user_123",
          tokenPayload: payload(),
          claim: claim(),
          trial: trial(),
          entitlement: entitlement(),
        },
        expected: {
          status: "linked",
          checkout_safe: true,
          user_id: "user_123",
          has_active_entitlement: false,
        },
      },
      {
        name: "same-user retry",
        input: {
          currentUserId: "user_123",
          tokenPayload: payload(),
          claim: claim({ redeemed_at: new Date().toISOString() }),
          trial: trial({ user_id: "user_123" }),
          entitlement: entitlement({ subscription_status: "active" }),
        },
        expected: {
          status: "already_linked_same_user",
          checkout_safe: true,
          user_id: "user_123",
          has_active_entitlement: true,
        },
      },
      {
        name: "fresh token for same-user install",
        input: {
          currentUserId: "user_123",
          tokenPayload: payload(),
          claim: claim(),
          trial: trial({ user_id: "user_123", status: "linked" }),
          entitlement: entitlement(),
        },
        expected: {
          status: "linked",
          checkout_safe: true,
          user_id: "user_123",
          has_active_entitlement: false,
        },
      },
      {
        name: "different-user retry",
        input: {
          currentUserId: "user_123",
          tokenPayload: payload(),
          claim: claim(),
          trial: trial({ user_id: "user_456" }),
          entitlement: entitlement(),
        },
        expected: {
          status: "already_linked_different_user",
          checkout_safe: false,
        },
      },
      {
        name: "expired token",
        input: {
          currentUserId: "user_123",
          tokenPayload: payload({ expires_at: expired }),
          claim: claim({ expires_at: expired }),
          trial: trial(),
          entitlement: entitlement(),
        },
        expected: { status: "expired_claim", checkout_safe: false },
      },
      {
        name: "claim mismatch",
        input: {
          currentUserId: "user_123",
          tokenPayload: payload({ claim_id: "claim_other" }),
          claim: claim(),
          trial: trial(),
          entitlement: entitlement(),
        },
        expected: { status: "invalid_claim", checkout_safe: false },
      },
    ];

    for (const { name, input, expected } of cases) {
      expect({ name, outcome: resolveClaimConversionOutcome(input) }).toEqual({
        name,
        outcome: expected,
      });
    }
  });
});

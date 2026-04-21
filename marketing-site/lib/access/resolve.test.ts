import { describe, expect, test } from "bun:test";
import type { AnonymousTrialRow, EntitlementRow } from "./types";
import { normalizeTrialState, resolveAccessDecision } from "./resolve";

const now = new Date();

function buildTrial(
  overrides: Partial<AnonymousTrialRow> = {},
): AnonymousTrialRow {
  return {
    id: "trial_123",
    install_id: "install_123",
    device_fingerprint_hash: "fingerprint_123",
    user_id: null,
    status: "new",
    trial_started_at: null,
    trial_ends_at: null,
    last_seen_at: now.toISOString(),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    ...overrides,
  };
}

function buildEntitlement(
  overrides: Partial<EntitlementRow> = {},
): EntitlementRow {
  return {
    user_id: "user_123",
    subscription_status: "inactive",
    stripe_customer_id: null,
    stripe_subscription_id: null,
    current_period_ends_at: null,
    updated_at: now.toISOString(),
    ...overrides,
  };
}

describe("access resolution", () => {
  test("blocks a fresh install before trial or checkout", () => {
    const trial = buildTrial();
    const decision = resolveAccessDecision(trial, null);

    expect(decision).toEqual({
      trialState: "new",
      accessState: "blocked",
      entitlementState: "inactive",
    });
  });

  test("treats an expired trial as blocked access", () => {
    const trial = buildTrial({
      status: "trialing",
      trial_started_at: new Date(
        Date.now() - 48 * 60 * 60 * 1000,
      ).toISOString(),
      trial_ends_at: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(normalizeTrialState(trial)).toBe("expired");
    expect(resolveAccessDecision(trial, null)).toEqual({
      trialState: "expired",
      accessState: "blocked",
      entitlementState: "inactive",
    });
  });

  test("unlocks checkout-linked subscriptions", () => {
    const trial = buildTrial({
      status: "expired",
      trial_ends_at: new Date(Date.now() - 60_000).toISOString(),
      user_id: "user_123",
    });
    const entitlement = buildEntitlement({
      subscription_status: "active",
    });

    expect(resolveAccessDecision(trial, entitlement)).toEqual({
      trialState: "expired",
      accessState: "subscribed",
      entitlementState: "active",
    });
  });
});

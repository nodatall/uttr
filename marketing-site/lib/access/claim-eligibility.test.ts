import { describe, expect, test } from "bun:test";
import { trialCanCreateClaim } from "./claim-eligibility";
import type { AnonymousTrialRow } from "./types";

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

describe("claim eligibility", () => {
  test("allows unlinked new, trialing, and expired installs", () => {
    for (const status of ["new", "trialing", "expired"] as const) {
      expect(
        trialCanCreateClaim(trial({ status }), { accessState: "blocked" }),
      ).toBe(true);
    }
  });

  test("allows linked installs that are not subscribed", () => {
    expect(
      trialCanCreateClaim(trial({ user_id: "user_123" }), {
        accessState: "blocked",
      }),
    ).toBe(true);
  });

  test("blocks subscribed installs even when linked", () => {
    expect(
      trialCanCreateClaim(trial({ user_id: "user_123" }), {
        accessState: "subscribed",
      }),
    ).toBe(false);
  });

  test("blocks unlinked subscribed installs", () => {
    expect(
      trialCanCreateClaim(trial(), {
        accessState: "subscribed",
      }),
    ).toBe(false);
  });
});

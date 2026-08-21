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
  test("allows claims for unpaid installs and blocks subscribed installs", () => {
    const cases = [
      ...(["new", "trialing", "expired"] as const).map((status) => ({
        name: `unlinked ${status}`,
        row: trial({ status }),
        accessState: "blocked" as const,
        expected: true,
      })),
      {
        name: "linked but unpaid",
        row: trial({ user_id: "user_123" }),
        accessState: "blocked" as const,
        expected: true,
      },
      {
        name: "linked and subscribed",
        row: trial({ user_id: "user_123" }),
        accessState: "subscribed" as const,
        expected: false,
      },
      {
        name: "unlinked and subscribed",
        row: trial(),
        accessState: "subscribed" as const,
        expected: false,
      },
    ];

    for (const { name, row, accessState, expected } of cases) {
      expect({
        name,
        allowed: trialCanCreateClaim(row, { accessState }),
      }).toEqual({
        name,
        allowed: expected,
      });
    }
  });
});

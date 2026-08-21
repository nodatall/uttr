import { describe, expect, test } from "bun:test";
import { checkoutRequiresClaimToken } from "./checkout-policy";

describe("checkout claim-token policy", () => {
  test("requires a claim only for first purchase without a token", () => {
    const cases = [
      {
        hasActiveEntitlement: false,
        claimToken: null,
        expected: true,
      },
      { hasActiveEntitlement: true, claimToken: null, expected: false },
      {
        hasActiveEntitlement: false,
        claimToken: "claim_123",
        expected: false,
      },
    ];

    for (const { expected, ...input } of cases) {
      expect(checkoutRequiresClaimToken(input)).toBe(expected);
    }
  });
});

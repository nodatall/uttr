import { describe, expect, test } from "bun:test";
import { checkoutRequiresClaimToken } from "./checkout-policy";

describe("checkout claim-token policy", () => {
  test("requires claim token for first purchase", () => {
    expect(
      checkoutRequiresClaimToken({
        hasActiveEntitlement: false,
        claimToken: null,
      }),
    ).toBe(true);
  });

  test("allows already-entitled users without a claim token", () => {
    expect(
      checkoutRequiresClaimToken({
        hasActiveEntitlement: true,
        claimToken: null,
      }),
    ).toBe(false);
  });

  test("allows first purchase when a claim token is present", () => {
    expect(
      checkoutRequiresClaimToken({
        hasActiveEntitlement: false,
        claimToken: "claim_123",
      }),
    ).toBe(false);
  });
});

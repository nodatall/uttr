import { describe, expect, test } from "bun:test";
import { buildCheckoutMetadata, STRIPE_API_VERSION } from "./stripe";

describe("Stripe client configuration", () => {
  test("uses the current pinned API version", () => {
    expect(STRIPE_API_VERSION).toBe("2026-03-25.dahlia");
  });
});

describe("checkout metadata", () => {
  test("includes install linkage when present", () => {
    expect(
      buildCheckoutMetadata({
        source: "web_checkout",
        userId: "user_123",
        anonymousTrialId: "trial_123",
        installId: "install_123",
      }),
    ).toEqual({
      source: "web_checkout",
      user_id: "user_123",
      anonymous_trial_id: "trial_123",
      install_id: "install_123",
    });
  });

  test("omits optional install linkage when unavailable", () => {
    expect(
      buildCheckoutMetadata({
        source: "web_checkout",
        userId: "user_123",
      }),
    ).toEqual({
      source: "web_checkout",
      user_id: "user_123",
    });
  });
});

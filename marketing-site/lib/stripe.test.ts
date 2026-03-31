import { describe, expect, test } from "bun:test";
import { buildCheckoutMetadata } from "./stripe";

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

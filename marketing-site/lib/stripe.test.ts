import { describe, expect, test } from "bun:test";
import { buildCheckoutMetadata } from "./stripe";

describe("checkout metadata", () => {
  test("includes only available install linkage", () => {
    const cases = [
      {
        input: {
          source: "web_checkout",
          userId: "user_123",
          anonymousTrialId: "trial_123",
          installId: "install_123",
        },
        expected: {
          source: "web_checkout",
          user_id: "user_123",
          anonymous_trial_id: "trial_123",
          install_id: "install_123",
        },
      },
      {
        input: { source: "web_checkout", userId: "user_123" },
        expected: { source: "web_checkout", user_id: "user_123" },
      },
    ];

    for (const { input, expected } of cases) {
      expect(buildCheckoutMetadata(input)).toEqual(expected);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { resolveClaimConversionClientDecision } from "./claim-conversion-client";

describe("claim conversion client decision", () => {
  test("continues checkout for fresh link and same-user retry statuses", () => {
    expect(
      resolveClaimConversionClientDecision({
        status: "linked",
        checkout_safe: true,
      }),
    ).toEqual({ kind: "continue_checkout" });

    expect(
      resolveClaimConversionClientDecision({
        status: "already_linked_same_user",
        checkout_safe: true,
      }),
    ).toEqual({ kind: "continue_checkout" });
  });

  test("redirects already-entitled responses when a return URL is provided", () => {
    expect(
      resolveClaimConversionClientDecision({
        status: "active",
        already_entitled: true,
        return_url: "https://uttr.test/account",
      }),
    ).toEqual({
      kind: "redirect",
      returnUrl: "https://uttr.test/account",
    });
  });

  test("blocks unsafe, unknown, and checkout_safe false responses", () => {
    expect(
      resolveClaimConversionClientDecision({
        status: "already_linked_different_user",
        checkout_safe: false,
      }),
    ).toEqual({
      kind: "error",
      message:
        "This claim link is tied to another Uttr account. Sign in with that account, or reopen the claim from Uttr.",
    });

    expect(
      resolveClaimConversionClientDecision({
        status: "expired_claim",
        checkout_safe: false,
      }),
    ).toEqual({
      kind: "error",
      message:
        "This claim link expired. Open Uttr again to create a fresh claim link.",
    });

    expect(
      resolveClaimConversionClientDecision({
        status: "invalid_claim",
        checkout_safe: false,
      }),
    ).toEqual({
      kind: "error",
      message:
        "This claim link is no longer valid. Open the claim flow from Uttr again.",
    });

    expect(
      resolveClaimConversionClientDecision({
        status: "linked",
        checkout_safe: false,
      }),
    ).toEqual({
      kind: "error",
      message:
        "This claim cannot continue to checkout. Open the claim flow from Uttr again.",
    });

    expect(
      resolveClaimConversionClientDecision({
        status: "linked",
      }),
    ).toEqual({
      kind: "error",
      message:
        "We could not verify this claim response. Open the claim flow from Uttr again.",
    });

    expect(
      resolveClaimConversionClientDecision({
        status: "mystery_status",
        checkout_safe: true,
        error: "Nope.",
      }),
    ).toEqual({
      kind: "error",
      message: "Nope.",
    });
  });
});

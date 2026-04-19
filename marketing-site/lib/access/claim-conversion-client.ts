import {
  claimConversionStatuses,
  type ClaimConversionStatus,
} from "./claim-conversion";

const safeCheckoutStatuses = new Set<ClaimConversionStatus>([
  "linked",
  "already_linked_same_user",
]);

const unsafeStatusMessages: Record<
  Exclude<ClaimConversionStatus, "linked" | "already_linked_same_user">,
  string
> = {
  already_linked_different_user:
    "This claim link is tied to another Uttr account. Sign in with that account, or reopen the claim from Uttr.",
  expired_claim:
    "This claim link expired. Open Uttr again to create a fresh claim link.",
  invalid_claim:
    "This claim link is no longer valid. Open the claim flow from Uttr again.",
};

export type ClaimConversionClientPayload = {
  status?: string;
  checkout_safe?: boolean;
  error?: string;
  return_url?: string;
  already_entitled?: boolean;
  has_active_entitlement?: boolean;
};

export type ClaimConversionClientDecision =
  | {
      kind: "continue_checkout";
    }
  | {
      kind: "redirect";
      returnUrl: string;
    }
  | {
      kind: "error";
      message: string;
    };

function isKnownClaimConversionStatus(status: string): status is ClaimConversionStatus {
  return claimConversionStatuses.includes(status as ClaimConversionStatus);
}

function isUsableReturnUrl(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function buildErrorMessage(payload: ClaimConversionClientPayload) {
  if (payload.status && isKnownClaimConversionStatus(payload.status)) {
    if (payload.status in unsafeStatusMessages) {
      return unsafeStatusMessages[payload.status as keyof typeof unsafeStatusMessages];
    }
  }

  if (payload.checkout_safe === false) {
    return (
      payload.error ||
      "This claim cannot continue to checkout. Open the claim flow from Uttr again."
    );
  }

  return (
    payload.error ||
    "We could not verify this claim response. Open the claim flow from Uttr again."
  );
}

export function resolveClaimConversionClientDecision(
  payload: ClaimConversionClientPayload,
): ClaimConversionClientDecision {
  const status = payload.status;
  const returnUrl = payload.return_url;

  if (
    (payload.already_entitled === true ||
      payload.has_active_entitlement === true ||
      status === "already_entitled" ||
      status === "active") &&
    isUsableReturnUrl(returnUrl)
  ) {
    return {
      kind: "redirect",
      returnUrl,
    };
  }

  if (status && isKnownClaimConversionStatus(status)) {
    if (safeCheckoutStatuses.has(status) && payload.checkout_safe === true) {
      return {
        kind: "continue_checkout",
      };
    }

    return {
      kind: "error",
      message: buildErrorMessage(payload),
    };
  }

  return {
    kind: "error",
    message: buildErrorMessage(payload),
  };
}

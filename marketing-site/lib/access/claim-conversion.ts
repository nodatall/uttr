import type {
  AnonymousTrialRow,
  ClaimTokenPayload,
  EntitlementRow,
  TrialClaimRow,
} from "./types";

export const claimConversionStatuses = [
  "linked",
  "already_linked_same_user",
  "already_linked_different_user",
  "expired_claim",
  "invalid_claim",
] as const;

export type ClaimConversionStatus = (typeof claimConversionStatuses)[number];

export type ClaimConversionOutcome =
  | {
      status: "linked";
      checkout_safe: true;
      user_id: string;
      has_active_entitlement: boolean;
    }
  | {
      status: "already_linked_same_user";
      checkout_safe: true;
      user_id: string;
      has_active_entitlement: boolean;
    }
  | {
      status: "already_linked_different_user";
      checkout_safe: false;
    }
  | {
      status: "expired_claim";
      checkout_safe: false;
    }
  | {
      status: "invalid_claim";
      checkout_safe: false;
    };

function isExpired(isoTimestamp: string) {
  return new Date(isoTimestamp).getTime() <= Date.now();
}

function hasActiveEntitlement(entitlement: EntitlementRow | null) {
  return entitlement?.subscription_status === "active";
}

export function resolveClaimConversionOutcome(params: {
  currentUserId: string;
  tokenPayload: ClaimTokenPayload;
  claim: TrialClaimRow | null;
  trial: AnonymousTrialRow | null;
  entitlement: EntitlementRow | null;
}): ClaimConversionOutcome {
  const { currentUserId, tokenPayload, claim, trial, entitlement } = params;

  if (!claim) {
    return {
      status: "invalid_claim",
      checkout_safe: false,
    };
  }

  if (
    claim.id !== tokenPayload.claim_id ||
    claim.anonymous_trial_id !== tokenPayload.anonymous_trial_id
  ) {
    return {
      status: "invalid_claim",
      checkout_safe: false,
    };
  }

  if (isExpired(tokenPayload.expires_at) || isExpired(claim.expires_at)) {
    return {
      status: "expired_claim",
      checkout_safe: false,
    };
  }

  if (!trial || trial.install_id !== tokenPayload.install_id) {
    return {
      status: "invalid_claim",
      checkout_safe: false,
    };
  }

  if (trial.user_id && trial.user_id !== currentUserId) {
    return {
      status: "already_linked_different_user",
      checkout_safe: false,
    };
  }

  if (trial.user_id === currentUserId && claim.redeemed_at) {
    return {
      status: "already_linked_same_user",
      checkout_safe: true,
      user_id: currentUserId,
      has_active_entitlement: hasActiveEntitlement(entitlement),
    };
  }

  if (claim.redeemed_at) {
    return {
      status: "invalid_claim",
      checkout_safe: false,
    };
  }

  return {
    status: "linked",
    checkout_safe: true,
    user_id: currentUserId,
    has_active_entitlement: hasActiveEntitlement(entitlement),
  };
}

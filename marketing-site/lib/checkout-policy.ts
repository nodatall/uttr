export function checkoutRequiresClaimToken(params: {
  hasActiveEntitlement: boolean;
  claimToken?: string | null;
}) {
  return !params.hasActiveEntitlement && !params.claimToken;
}

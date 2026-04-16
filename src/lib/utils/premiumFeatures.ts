import type { InstallAccessSnapshot } from "@/bindings";

export const PREMIUM_FEATURE_LOCK_MESSAGE =
  "Upgrade to Pro to use this feature.";

export function hasPremiumFeatureAccess(
  installAccess: InstallAccessSnapshot | null,
) {
  if (!installAccess) {
    return false;
  }

  return (
    installAccess.has_byok_secret ||
    installAccess.access_state === "trialing" ||
    installAccess.access_state === "subscribed"
  );
}

export function isPremiumFeatureLocked(
  installAccess: InstallAccessSnapshot | null,
) {
  return installAccess !== null && !hasPremiumFeatureAccess(installAccess);
}

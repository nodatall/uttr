import type { InstallAccessSnapshot } from "@/bindings";

export const PREMIUM_FEATURE_LOCK_MESSAGE =
  "Please purchase a subscription to use this feature. You can also add your own Groq API key in API Keys.";

export function hasPremiumFeatureAccess(
  installAccess: InstallAccessSnapshot | null,
) {
  if (!installAccess) {
    return false;
  }

  return (
    installAccess.has_byok_secret || installAccess.access_state === "subscribed"
  );
}

export function isPremiumFeatureLocked(
  installAccess: InstallAccessSnapshot | null,
) {
  return installAccess !== null && !hasPremiumFeatureAccess(installAccess);
}

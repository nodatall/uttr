import type { InstallAccessSnapshot } from "@/bindings";

export const PREMIUM_FEATURE_LOCK_MESSAGE =
  "Upgrade to Pro to use this feature.";

export function isDevPlanSimulationActive(
  installAccess: InstallAccessSnapshot | null,
) {
  return (
    installAccess?.dev_access_override === "free" ||
    installAccess?.dev_access_override === "trial" ||
    installAccess?.dev_access_override === "pro"
  );
}

export function shouldShowModelControls(
  installAccess: InstallAccessSnapshot | null,
) {
  if (!installAccess || isDevPlanSimulationActive(installAccess)) {
    return false;
  }

  return installAccess.has_byok_secret;
}

export function hasPremiumFeatureAccess(
  installAccess: InstallAccessSnapshot | null,
) {
  if (!installAccess) {
    return false;
  }

  if (isDevPlanSimulationActive(installAccess)) {
    return (
      installAccess.access_state === "trialing" ||
      installAccess.access_state === "subscribed"
    );
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

import type { InstallAccessSnapshot } from "@/bindings";

export const PREMIUM_FEATURE_LOCK_MESSAGE =
  "Upgrade to Pro to use this feature.";

export type DesktopBillingSurface = "manage" | "checkout";
export type DesktopBillingCheckoutMode = "claim" | "reactivate";
export type DesktopBillingManagementMode = "subscription" | "payment-update";
export type DesktopBillingCheckoutStatus =
  | "canceled"
  | "access-expired"
  | "linked-account"
  | "trialing"
  | "trial-expired"
  | "free";

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

function isSubscribedOrActive(installAccess: InstallAccessSnapshot) {
  return (
    installAccess.access_state === "subscribed" ||
    installAccess.entitlement_state === "active"
  );
}

function isPastDue(installAccess: InstallAccessSnapshot) {
  return installAccess.entitlement_state === "past_due";
}

function isLinkedInactive(installAccess: InstallAccessSnapshot) {
  return (
    installAccess.entitlement_state === "inactive" &&
    installAccess.trial_state === "linked"
  );
}

export function getDesktopBillingSurface(
  installAccess: InstallAccessSnapshot | null,
): DesktopBillingSurface | null {
  if (!installAccess) {
    return null;
  }

  if (isSubscribedOrActive(installAccess) || isPastDue(installAccess)) {
    return "manage";
  }

  return "checkout";
}

export function getDesktopBillingManagementMode(
  installAccess: InstallAccessSnapshot | null,
): DesktopBillingManagementMode | null {
  if (!installAccess || getDesktopBillingSurface(installAccess) !== "manage") {
    return null;
  }

  return isPastDue(installAccess)
    ? "payment-update"
    : "subscription";
}

export function getDesktopBillingCheckoutMode(
  installAccess: InstallAccessSnapshot | null,
): DesktopBillingCheckoutMode | null {
  if (getDesktopBillingSurface(installAccess) !== "checkout") {
    return null;
  }

  if (!installAccess) {
    return null;
  }

  if (
    installAccess.entitlement_state === "canceled" ||
    installAccess.entitlement_state === "expired" ||
    isLinkedInactive(installAccess)
  ) {
    return "reactivate";
  }

  return "claim";
}

export function getDesktopBillingCheckoutStatus(
  installAccess: InstallAccessSnapshot | null,
): DesktopBillingCheckoutStatus | null {
  if (!installAccess) {
    return null;
  }

  if (installAccess.entitlement_state === "canceled") {
    return "canceled";
  }

  if (installAccess.entitlement_state === "expired") {
    return "access-expired";
  }

  if (isLinkedInactive(installAccess)) {
    return "linked-account";
  }

  if (installAccess.trial_state === "trialing") {
    return "trialing";
  }

  if (installAccess.trial_state === "expired") {
    return "trial-expired";
  }

  return "free";
}

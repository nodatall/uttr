import React, { useCallback, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { commands } from "@/bindings";
import { useSettings } from "@/hooks/useSettings";
import {
  getDesktopBillingCheckoutMode,
  getDesktopBillingCheckoutStatus,
  getDesktopBillingSurface,
  isDevPlanSimulationActive,
} from "@/lib/utils/premiumFeatures";

const LOCAL_MARKETING_ORIGIN = "http://localhost:4317";

const toUpgradeUrl = (claimUrl: string) => {
  if (!import.meta.env.DEV) {
    return claimUrl;
  }

  try {
    const url = new URL(claimUrl);
    return `${LOCAL_MARKETING_ORIGIN}${url.pathname}${url.search}`;
  } catch {
    return claimUrl;
  }
};

export const UpgradeButton: React.FC = () => {
  const { t } = useTranslation();
  const { installAccess, refreshInstallAccess } = useSettings();
  const [isOpening, setIsOpening] = useState(false);

  const billingSurface = useMemo(
    () => getDesktopBillingSurface(installAccess),
    [installAccess],
  );
  const checkoutMode = useMemo(
    () => getDesktopBillingCheckoutMode(installAccess),
    [installAccess],
  );

  const shouldShow = useMemo(
    () =>
      installAccess !== null &&
      (!installAccess.has_byok_secret ||
        isDevPlanSimulationActive(installAccess)) &&
      billingSurface === "checkout",
    [billingSurface, installAccess],
  );

  const statusText = useMemo(() => {
    const status = getDesktopBillingCheckoutStatus(installAccess);

    switch (status) {
      case "canceled":
        return t("sidebar.upgradeStatusCanceled", {
          defaultValue: "Subscription canceled",
        });
      case "access-expired":
        return t("sidebar.upgradeStatusAccessExpired", {
          defaultValue: "Access expired",
        });
      case "linked-account":
        return t("sidebar.upgradeStatusLinkedAccount", {
          defaultValue: "Linked account",
        });
      case "trialing":
        return t("sidebar.upgradeStatusTrial", {
          defaultValue: "2-day trial active",
        });
      case "trial-expired":
        return t("sidebar.upgradeStatusExpired", {
          defaultValue: "Trial ended",
        });
      case "free":
        return t("sidebar.upgradeStatusFree", {
          defaultValue: "Free plan",
        });
      default:
        return "";
    }
  }, [installAccess, t]);

  const openUpgrade = useCallback(async () => {
    setIsOpening(true);

    try {
      await refreshInstallAccess();
      const claim = await commands.createTrialClaim();
      if (claim.status === "ok") {
        await openUrl(toUpgradeUrl(claim.data.claim_url));
        return;
      }

      toast.error(
        t("sidebar.upgradeOpenFailed", {
          defaultValue:
            "Could not start checkout. Try again from Uttr in a moment.",
        }),
      );
    } catch (error) {
      console.warn("Failed to open upgrade flow:", error);
      toast.error(
        t("sidebar.upgradeOpenFailed", {
          defaultValue:
            "Could not start checkout. Try again from Uttr in a moment.",
        }),
      );
    } finally {
      setIsOpening(false);
    }
  }, [refreshInstallAccess, t]);

  if (!shouldShow) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={() => void openUpgrade()}
      disabled={isOpening}
      className="group w-full rounded-xl border border-logo-primary/30 bg-[linear-gradient(135deg,rgba(29,155,100,0.22),rgba(29,155,100,0.08))] px-3 py-2.5 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition hover:border-logo-primary/45 hover:bg-logo-primary/18 disabled:cursor-wait disabled:opacity-60"
    >
      <span className="block text-sm font-semibold text-text">
        {isOpening
          ? t("sidebar.upgradeOpening", { defaultValue: "Opening..." })
          : checkoutMode === "reactivate"
            ? t("sidebar.reactivatePro", {
                defaultValue: "Reactivate Pro",
              })
            : t("sidebar.upgradeToPro", {
                defaultValue: "Upgrade to Pro",
              })}
      </span>
      <span className="mt-0.5 block text-xs leading-4 text-text/52">
        {t("sidebar.upgradeCaption", {
          defaultValue: "{{status}} - $5/month",
          status: statusText,
        })}
      </span>
    </button>
  );
};

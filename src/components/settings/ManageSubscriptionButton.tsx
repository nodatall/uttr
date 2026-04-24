import React, { useCallback, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/hooks/useSettings";
import {
  getDesktopBillingManagementMode,
  getDesktopBillingSurface,
} from "@/lib/utils/premiumFeatures";

const LOCAL_MARKETING_ORIGIN = "http://localhost:4317";
const PRODUCTION_ACCOUNT_URL =
  "https://uttr.pro/account?source=settings-subscription";

const toAccountUrl = () => {
  if (!import.meta.env.DEV) {
    return PRODUCTION_ACCOUNT_URL;
  }

  const url = new URL(PRODUCTION_ACCOUNT_URL);
  return `${LOCAL_MARKETING_ORIGIN}${url.pathname}${url.search}`;
};

export const ManageSubscriptionButton: React.FC = () => {
  const { t } = useTranslation();
  const { installAccess, refreshInstallAccess } = useSettings();
  const [isOpening, setIsOpening] = useState(false);

  const shouldShow = useMemo(
    () => getDesktopBillingSurface(installAccess) === "manage",
    [installAccess],
  );
  const managementMode = useMemo(
    () => getDesktopBillingManagementMode(installAccess),
    [installAccess],
  );

  const openAccount = useCallback(async () => {
    setIsOpening(true);

    try {
      await refreshInstallAccess();
      await openUrl(toAccountUrl());
    } catch (error) {
      console.warn("Failed to open subscription management:", error);
      await openUrl(toAccountUrl());
    } finally {
      setIsOpening(false);
    }
  }, [refreshInstallAccess]);

  if (!shouldShow) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={() => void openAccount()}
      disabled={isOpening}
      className="group w-full rounded-xl border border-white/10 bg-white/[0.035] px-3 py-2.5 text-left transition hover:border-white/18 hover:bg-white/[0.055] disabled:cursor-wait disabled:opacity-60"
    >
      <span className="block text-sm font-semibold text-text">
        {isOpening
          ? t("sidebar.manageSubscriptionOpening", {
              defaultValue: "Opening...",
            })
          : managementMode === "payment-update"
            ? t("sidebar.updatePayment", {
                defaultValue: "Update payment",
              })
            : t("sidebar.manageSubscription", {
                defaultValue: "Manage subscription",
              })}
      </span>
      <span className="mt-0.5 block text-xs leading-4 text-text/52">
        {managementMode === "payment-update"
          ? t("sidebar.manageSubscriptionPaymentCaption", {
              defaultValue: "Billing, invoices, payment method",
            })
          : t("sidebar.manageSubscriptionCaption", {
              defaultValue: "Billing, invoices, cancellation",
            })}
      </span>
    </button>
  );
};

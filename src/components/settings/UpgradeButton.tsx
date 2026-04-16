import React, { useCallback, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { commands } from "@/bindings";
import { useSettings } from "@/hooks/useSettings";

const FALLBACK_CLAIM_URL = "https://uttr.app/claim?source=settings-upgrade";

export const UpgradeButton: React.FC = () => {
  const { installAccess, refreshInstallAccess } = useSettings();
  const [isOpening, setIsOpening] = useState(false);

  const shouldShow = useMemo(() => {
    return (
      installAccess !== null &&
      !installAccess.has_byok_secret &&
      installAccess.access_state !== "subscribed"
    );
  }, [installAccess]);

  const statusText = useMemo(() => {
    if (!installAccess) {
      return "";
    }

    if (installAccess.trial_state === "trialing") {
      return "2-day trial active";
    }

    if (installAccess.trial_state === "expired") {
      return "Trial ended";
    }

    return "Free plan";
  }, [installAccess]);

  const openUpgrade = useCallback(async () => {
    setIsOpening(true);

    try {
      await refreshInstallAccess();
      const claim = await commands.createTrialClaim();
      if (claim.status === "ok") {
        await openUrl(claim.data.claim_url);
        return;
      }

      await openUrl(FALLBACK_CLAIM_URL);
    } catch (error) {
      console.warn("Failed to open upgrade flow:", error);
      await openUrl(FALLBACK_CLAIM_URL);
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
      onClick={() => void openUpgrade()}
      disabled={isOpening}
      className="group w-full rounded-xl border border-logo-primary/30 bg-[linear-gradient(135deg,rgba(29,155,100,0.22),rgba(29,155,100,0.08))] px-3 py-2.5 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition hover:border-logo-primary/45 hover:bg-logo-primary/18 disabled:cursor-wait disabled:opacity-60"
    >
      <span className="block text-sm font-semibold text-text">
        {isOpening ? "Opening..." : "Upgrade to Pro"}
      </span>
      <span className="mt-0.5 block text-xs leading-4 text-text/52">
        {statusText} · $5/month
      </span>
    </button>
  );
};

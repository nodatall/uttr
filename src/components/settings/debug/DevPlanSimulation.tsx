import React, { useCallback, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { InstallAccessSnapshot } from "@/bindings";
import { useSettings } from "@/hooks/useSettings";
import { SettingContainer } from "@/components/ui/SettingContainer";

type DevPlanMode = "free" | "trial" | "pro" | "none";

const OPTIONS: Array<{ mode: DevPlanMode; label: string }> = [
  { mode: "free", label: "Free" },
  { mode: "trial", label: "Trial" },
  { mode: "pro", label: "Pro" },
  { mode: "none", label: "Real" },
];

export const DevPlanSimulation: React.FC<{ grouped?: boolean }> = ({
  grouped = false,
}) => {
  const { installAccess, refreshInstallAccess } = useSettings();
  const [selectedMode, setSelectedMode] = useState<DevPlanMode>("none");
  const [isUpdating, setIsUpdating] = useState(false);

  const currentLabel = useMemo(() => {
    if (!installAccess) {
      return "Unknown";
    }

    if (installAccess.dev_access_override) {
      return `Simulated ${installAccess.dev_access_override}`;
    }

    if (installAccess.has_byok_secret) {
      return "BYOK";
    }

    return installAccess.access_state;
  }, [installAccess]);

  const activeMode =
    (installAccess?.dev_access_override as DevPlanMode | null) ?? selectedMode;

  const setMode = useCallback(
    async (mode: DevPlanMode) => {
      setIsUpdating(true);
      try {
        const snapshot = await invoke<InstallAccessSnapshot>(
          "set_dev_install_access_override",
          { mode },
        );
        setSelectedMode(mode);
        await refreshInstallAccess();
        window.dispatchEvent(
          new CustomEvent("uttr-dev-install-access", { detail: snapshot }),
        );
      } finally {
        setIsUpdating(false);
      }
    },
    [refreshInstallAccess],
  );

  if (!import.meta.env.DEV) {
    return null;
  }

  return (
    <SettingContainer
      title="Plan simulation"
      description="Force the local access state for testing locked and paid UI."
      grouped={grouped}
      layout="stacked"
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-mid-gray">Current access: {currentLabel}</p>
        <div className="flex flex-wrap gap-2">
          {OPTIONS.map((option) => (
            <button
              key={option.mode}
              type="button"
              disabled={isUpdating}
              onClick={() => void setMode(option.mode)}
              className={`rounded-lg border px-3 py-1.5 text-sm transition disabled:cursor-wait disabled:opacity-60 ${
                activeMode === option.mode
                  ? "border-logo-primary/45 bg-logo-primary/18 text-text"
                  : "border-white/10 bg-white/[0.03] text-text/70 hover:border-white/18 hover:text-text"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </SettingContainer>
  );
};

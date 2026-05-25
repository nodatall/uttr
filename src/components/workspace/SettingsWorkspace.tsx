import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/hooks/useSettings";
import {
  ApiKeysSettings,
  DebugSettings,
  GeneralSettings,
  ModelsSettings,
} from "@/components/settings";
import { shouldShowModelControls } from "@/lib/utils/premiumFeatures";

type SettingsTab = "general" | "models" | "providers" | "debug";

interface SettingsTabConfig {
  id: SettingsTab;
  label: string;
}

export const SettingsWorkspace: React.FC = () => {
  const { t } = useTranslation();
  const { settings, installAccess } = useSettings();
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const showModelControls = shouldShowModelControls(installAccess);
  const showDebug = settings?.debug_mode ?? false;

  const tabs = useMemo<SettingsTabConfig[]>(() => {
    const visibleTabs: SettingsTabConfig[] = [
      { id: "general", label: t("sidebar.general") },
      {
        id: "providers",
        label: t("workspace.settings.providers", {
          defaultValue: "Providers",
        }),
      },
    ];

    if (showModelControls) {
      visibleTabs.splice(1, 0, {
        id: "models",
        label: t("sidebar.models"),
      });
    }

    if (showDebug) {
      visibleTabs.push({ id: "debug", label: t("sidebar.debug") });
    }

    return visibleTabs;
  }, [showDebug, showModelControls, t]);

  const effectiveTab = tabs.some((tab) => tab.id === activeTab)
    ? activeTab
    : "general";

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5">
      <div className="flex justify-end">
        <div className="flex rounded-full border border-white/8 bg-white/[0.025] p-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                effectiveTab === tab.id
                  ? "bg-logo-primary/14 text-logo-primary shadow-[inset_0_0_0_1px_rgba(103,215,163,0.18)]"
                  : "text-text/58 hover:bg-white/[0.04] hover:text-text"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {effectiveTab === "general" && <GeneralSettings />}
      {effectiveTab === "models" && <ModelsSettings />}
      {effectiveTab === "providers" && <ApiKeysSettings />}
      {effectiveTab === "debug" && <DebugSettings />}
    </div>
  );
};

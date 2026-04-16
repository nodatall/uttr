import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import {
  FlaskConical,
  History,
  Cpu,
  AudioLines,
  FileAudio,
  KeyRound,
} from "lucide-react";
import { useSettings } from "../hooks/useSettings";
import {
  GeneralSettings,
  HistorySettings,
  DebugSettings,
  ModelsSettings,
  ApiKeysSettings,
  FileTranscriptionSettings,
} from "./settings";
import UpdateChecker from "./update-checker";
import { UpgradeButton } from "./settings/UpgradeButton";
import {
  isDevPlanSimulationActive,
  shouldShowModelControls,
} from "@/lib/utils/premiumFeatures";

export type SidebarSection = keyof typeof SECTIONS_CONFIG;

interface IconProps {
  width?: number | string;
  height?: number | string;
  size?: number | string;
  className?: string;
  [key: string]: any;
}

interface SectionConfig {
  labelKey: string;
  defaultLabel?: string;
  icon: React.ComponentType<IconProps>;
  component: React.ComponentType;
  enabled: (settings: any) => boolean;
}

export const SECTIONS_CONFIG = {
  general: {
    labelKey: "sidebar.general",
    icon: AudioLines,
    component: GeneralSettings,
    enabled: () => true,
  },
  models: {
    labelKey: "sidebar.models",
    icon: Cpu,
    component: ModelsSettings,
    enabled: () => true,
  },
  apiKeys: {
    labelKey: "sidebar.apiKeys",
    icon: KeyRound,
    component: ApiKeysSettings,
    enabled: () => true,
  },
  history: {
    labelKey: "sidebar.history",
    icon: History,
    component: HistorySettings,
    enabled: () => true,
  },
  fileTranscription: {
    labelKey: "sidebar.fileTranscription",
    defaultLabel: "File Transcription",
    icon: FileAudio,
    component: FileTranscriptionSettings,
    enabled: () => true,
  },
  debug: {
    labelKey: "sidebar.debug",
    icon: FlaskConical,
    component: DebugSettings,
    enabled: (settings) => settings?.debug_mode ?? false,
  },
} as const satisfies Record<string, SectionConfig>;

interface SidebarProps {
  activeSection: SidebarSection;
  onSectionChange: (section: SidebarSection) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeSection,
  onSectionChange,
}) => {
  const { t } = useTranslation();
  const { settings, installAccess } = useSettings();
  const [version, setVersion] = useState("");
  const versionTapCountRef = useRef(0);
  const versionTapTimerRef = useRef<number | null>(null);
  const isPlanSimulationActive = isDevPlanSimulationActive(installAccess);
  const showModelControls = shouldShowModelControls(installAccess);

  useEffect(() => {
    const fetchVersion = async () => {
      try {
        setVersion(await getVersion());
      } catch (error) {
        console.error("Failed to get app version:", error);
        setVersion("0.1.2");
      }
    };

    void fetchVersion();
  }, []);

  useEffect(() => {
    return () => {
      if (versionTapTimerRef.current !== null) {
        window.clearTimeout(versionTapTimerRef.current);
      }
    };
  }, []);

  const handleVersionTap = () => {
    versionTapCountRef.current += 1;
    if (versionTapTimerRef.current === null) {
      versionTapTimerRef.current = window.setTimeout(() => {
        versionTapCountRef.current = 0;
        versionTapTimerRef.current = null;
      }, 1200);
    }

    if (versionTapCountRef.current >= 5) {
      if (versionTapTimerRef.current !== null) {
        window.clearTimeout(versionTapTimerRef.current);
        versionTapTimerRef.current = null;
      }
      versionTapCountRef.current = 0;
      if (isPlanSimulationActive) {
        return;
      }
      onSectionChange("apiKeys");
    }
  };

  const availableSections = Object.entries(SECTIONS_CONFIG)
    .filter(([id, config]) => {
      if (id === "apiKeys") {
        if (isPlanSimulationActive) {
          return false;
        }

        if (!settings?.debug_mode && !installAccess?.has_byok_secret) {
          return false;
        }
      }

      if (id === "models" && !showModelControls) {
        return false;
      }

      return config.enabled(settings);
    })
    .map(([id, config]) => ({ id: id as SidebarSection, ...config }));

  return (
    <div className="flex w-full min-w-0 flex-col rounded-[18px] border border-white/6 bg-[rgba(4,9,15,0.45)] px-3 py-4 md:h-full md:w-[214px] md:min-w-[214px]">
      <div className="mb-4 px-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-text/35">
          {t("sidebar.workspace", { defaultValue: "Uttr" })}
        </p>
      </div>
      <div className="flex min-h-0 flex-1 gap-1.5 overflow-x-auto pb-1 uttr-scrollbar md:flex-col md:overflow-x-hidden md:overflow-y-auto md:pb-0">
        {availableSections.map((section) => {
          const Icon = section.icon;
          const isActive = activeSection === section.id;
          const defaultLabel =
            "defaultLabel" in section ? section.defaultLabel : undefined;

          return (
            <button
              type="button"
              key={section.id}
              className={`flex shrink-0 items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-all md:w-full ${
                isActive
                  ? "bg-[linear-gradient(90deg,rgba(29,155,100,0.2),rgba(29,155,100,0.08))] text-text shadow-[inset_0_0_0_1px_rgba(103,215,163,0.32)]"
                  : "text-text/72 hover:bg-white/[0.04] hover:text-text"
              }`}
              onClick={() => onSectionChange(section.id)}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full transition-all ${
                  isActive
                    ? "bg-logo-primary shadow-[0_0_10px_rgba(103,215,163,0.55)]"
                    : "bg-transparent"
                }`}
              />
              <Icon
                width={17}
                height={17}
                className={`shrink-0 ${isActive ? "text-logo-primary" : ""}`}
              />
              <p
                className="text-sm font-medium truncate"
                title={t(section.labelKey, {
                  defaultValue: defaultLabel,
                })}
              >
                {t(section.labelKey, {
                  defaultValue: defaultLabel,
                })}
              </p>
            </button>
          );
        })}
      </div>
      <div className="mt-4 shrink-0 border-t border-white/6 px-2 pt-4">
        <div className="flex flex-col gap-1.5 text-xs text-text/48">
          <UpgradeButton />
          <UpdateChecker className="min-w-0" />
          <button
            type="button"
            onClick={handleVersionTap}
            className="w-fit rounded-md px-1 py-0.5 text-left text-text/28 transition hover:bg-white/[0.04] hover:text-text/42"
            aria-label={t("sidebar.version", { defaultValue: "App version" })}
          >
            {t("sidebar.versionPrefix", { defaultValue: "v" })}
            {version}
          </button>
        </div>
      </div>
    </div>
  );
};

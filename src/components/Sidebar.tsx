import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { History, Home, FileAudio, Settings } from "lucide-react";
import { useSettings } from "../hooks/useSettings";
import UpdateChecker from "./update-checker";
import { ManageSubscriptionButton } from "./settings/ManageSubscriptionButton";
import { UpgradeButton } from "./settings/UpgradeButton";

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
  enabled: (settings: any) => boolean;
}

export const SECTIONS_CONFIG = {
  settings: {
    labelKey: "sidebar.settings",
    defaultLabel: "Settings",
    icon: Settings,
    enabled: () => true,
  },
  home: {
    labelKey: "sidebar.home",
    defaultLabel: "Meetings",
    icon: Home,
    enabled: () => true,
  },
  files: {
    labelKey: "sidebar.files",
    defaultLabel: "Files",
    icon: FileAudio,
    enabled: () => true,
  },
  history: {
    labelKey: "sidebar.history",
    defaultLabel: "History",
    icon: History,
    enabled: () => true,
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
  const { installAccess } = useSettings();
  const [version, setVersion] = useState("");
  const versionTapCountRef = useRef(0);
  const versionTapTimerRef = useRef<number | null>(null);
  const showAccountControls = installAccess !== null;

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
      onSectionChange("settings");
    }
  };

  const availableSections = Object.entries(SECTIONS_CONFIG)
    .filter(([, config]) => config.enabled())
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
          {showAccountControls && <UpgradeButton />}
          {showAccountControls && <ManageSubscriptionButton />}
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

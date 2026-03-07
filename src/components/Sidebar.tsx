import React from "react";
import { useTranslation } from "react-i18next";
import {
  FlaskConical,
  History,
  Cpu,
  AudioLines,
  KeyRound,
} from "lucide-react";
import { useSettings } from "../hooks/useSettings";
import {
  GeneralSettings,
  HistorySettings,
  DebugSettings,
  ModelsSettings,
  ApiKeysSettings,
} from "./settings";

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
  const { settings } = useSettings();

  const availableSections = Object.entries(SECTIONS_CONFIG)
    .filter(([_, config]) => config.enabled(settings))
    .map(([id, config]) => ({ id: id as SidebarSection, ...config }));

  return (
    <div className="flex h-full w-[214px] min-w-[214px] flex-col rounded-[18px] border border-white/6 bg-[rgba(4,9,15,0.45)] px-3 py-4">
      <div className="mb-4 px-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-text/35">
          {t("sidebar.workspace", { defaultValue: "Uttr" })}
        </p>
      </div>
      <div className="flex flex-col w-full gap-1.5 overflow-y-auto uttr-scrollbar">
        {availableSections.map((section) => {
          const Icon = section.icon;
          const isActive = activeSection === section.id;

          return (
            <button
              type="button"
              key={section.id}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-all ${
                isActive
                  ? "bg-[linear-gradient(90deg,rgba(29,155,100,0.2),rgba(29,155,100,0.08))] text-text shadow-[inset_0_0_0_1px_rgba(103,215,163,0.32)]"
                  : "text-text/72 hover:bg-white/[0.04] hover:text-text"
              }`}
              onClick={() => onSectionChange(section.id)}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full transition-all ${
                  isActive ? "bg-logo-primary shadow-[0_0_10px_rgba(103,215,163,0.55)]" : "bg-transparent"
                }`}
              />
              <Icon
                width={17}
                height={17}
                className={`shrink-0 ${isActive ? "text-logo-primary" : ""}`}
              />
              <p
                className="text-sm font-medium truncate"
                title={t(section.labelKey)}
              >
                {t(section.labelKey)}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
};

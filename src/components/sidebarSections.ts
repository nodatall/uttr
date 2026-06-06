import type React from "react";
import {
  Cpu,
  FileAudio,
  History,
  Home,
  KeyRound,
  Settings,
} from "lucide-react";
import { shouldShowModelControls } from "@/lib/utils/premiumFeatures";

interface IconProps {
  width?: number | string;
  height?: number | string;
  size?: number | string;
  className?: string;
  [key: string]: any;
}

export interface SectionConfig {
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
  models: {
    labelKey: "sidebar.models",
    defaultLabel: "Models",
    icon: Cpu,
    enabled: (settings) =>
      shouldShowModelControls(settings?.installAccess ?? null) ||
      Boolean(
        settings?.settings?.byok_enabled || settings?.settings?.debug_mode,
      ),
  },
  apiKeys: {
    labelKey: "sidebar.apiKeys",
    defaultLabel: "API Keys",
    icon: KeyRound,
    enabled: (settings) =>
      shouldShowModelControls(settings?.installAccess ?? null) ||
      Boolean(
        settings?.settings?.byok_enabled || settings?.settings?.debug_mode,
      ),
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
    defaultLabel: "Transcriptions",
    icon: History,
    enabled: () => true,
  },
} as const satisfies Record<string, SectionConfig>;

export type SidebarSection = keyof typeof SECTIONS_CONFIG;

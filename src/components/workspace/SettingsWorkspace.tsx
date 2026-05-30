import React from "react";
import { useSettings } from "@/hooks/useSettings";
import { DebugSettings, GeneralSettings } from "@/components/settings";

export const SettingsWorkspace: React.FC = () => {
  const { settings } = useSettings();
  const showDebug = settings?.debug_mode ?? false;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8">
      <GeneralSettings />
      {showDebug && <DebugSettings />}
    </div>
  );
};

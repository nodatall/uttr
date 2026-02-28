import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { useSettings } from "../../hooks/useSettings";

interface IncrementalTranscriptionToggleProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const IncrementalTranscriptionToggle: React.FC<IncrementalTranscriptionToggleProps> =
  React.memo(({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();

    const enabled = getSetting("incremental_transcription_enabled") ?? true;

    return (
      <ToggleSwitch
        checked={enabled}
        onChange={(next) =>
          updateSetting("incremental_transcription_enabled", next)
        }
        isUpdating={isUpdating("incremental_transcription_enabled")}
        label={t("settings.advanced.incrementalTranscription.label")}
        description={t("settings.advanced.incrementalTranscription.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      />
    );
  });

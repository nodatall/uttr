import React from "react";
import { useTranslation } from "react-i18next";
import { ShowOverlay } from "../ShowOverlay";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { SettingContainer } from "../../ui/SettingContainer";
import { Button } from "../../ui/Button";
import { StartHidden } from "../StartHidden";
import { AutostartToggle } from "../AutostartToggle";
import { ShowTrayIcon } from "../ShowTrayIcon";
import { PasteMethodSetting } from "../PasteMethod";
import { TypingToolSetting } from "../TypingTool";
import { ClipboardHandlingSetting } from "../ClipboardHandling";
import { AutoSubmit } from "../AutoSubmit";
import { PostProcessingToggle } from "../PostProcessingToggle";
import { PostProcessingSettingsApi } from "../PostProcessingSettingsApi";
import { HistoryLimit } from "../HistoryLimit";
import { RecordingRetentionPeriodSelector } from "../RecordingRetentionPeriod";
import { useSettings } from "../../../hooks/useSettings";
import { requestShowModelOnboarding } from "@/lib/events/onboarding";

export const AdvancedSettings: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting } = useSettings();
  const postProcessEnabled = getSetting("post_process_enabled") || false;

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <SettingsGroup title={t("settings.advanced.groups.app")}>
        <StartHidden descriptionMode="tooltip" grouped={true} />
        <AutostartToggle descriptionMode="tooltip" grouped={true} />
        <ShowTrayIcon descriptionMode="tooltip" grouped={true} />
        <ShowOverlay descriptionMode="tooltip" grouped={true} />
        <SettingContainer
          title={t("settings.advanced.onboarding.title", {
            defaultValue: "Model onboarding",
          })}
          description={t("settings.advanced.onboarding.description", {
            defaultValue:
              "Open the model onboarding screen again to review or change the initial setup flow.",
          })}
          grouped={true}
        >
          <Button variant="secondary" onClick={requestShowModelOnboarding}>
            {t("settings.advanced.onboarding.action", {
              defaultValue: "Show onboarding",
            })}
          </Button>
        </SettingContainer>
      </SettingsGroup>

      <SettingsGroup title={t("settings.advanced.groups.output")}>
        <PasteMethodSetting descriptionMode="tooltip" grouped={true} />
        <TypingToolSetting descriptionMode="tooltip" grouped={true} />
        <ClipboardHandlingSetting descriptionMode="tooltip" grouped={true} />
        <AutoSubmit descriptionMode="tooltip" grouped={true} />
      </SettingsGroup>

      <SettingsGroup title={t("settings.advanced.groups.transcription")}>
        <PostProcessingToggle descriptionMode="tooltip" grouped={true} />
        {postProcessEnabled && <PostProcessingSettingsApi />}
      </SettingsGroup>

      <SettingsGroup title={t("settings.advanced.groups.history")}>
        <HistoryLimit descriptionMode="tooltip" grouped={true} />
        <RecordingRetentionPeriodSelector
          descriptionMode="tooltip"
          grouped={true}
        />
      </SettingsGroup>
    </div>
  );
};

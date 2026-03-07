import React from "react";
import { useTranslation } from "react-i18next";
import { MicrophoneSelector } from "../MicrophoneSelector";
import { ShortcutInput } from "../ShortcutInput";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { PushToTalk } from "../PushToTalk";
import { MuteWhileRecording } from "../MuteWhileRecording";
import { AutostartToggle } from "../AutostartToggle";
import { ShowTrayIcon } from "../ShowTrayIcon";
import { TypingToolSetting } from "../TypingTool";
import { PostProcessingToggle } from "../PostProcessingToggle";
import { PostProcessingSettingsApi } from "../PostProcessingSettingsApi";
import { HistoryLimit } from "../HistoryLimit";
import { RecordingRetentionPeriodSelector } from "../RecordingRetentionPeriod";
import { AppLanguageSelector } from "../AppLanguageSelector";
import { SettingContainer } from "../../ui/SettingContainer";
import { Button } from "../../ui/Button";
import { requestShowModelOnboarding } from "@/lib/events/onboarding";
import { useSettings } from "../../../hooks/useSettings";

export const GeneralSettings: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting } = useSettings();
  const postProcessEnabled = getSetting("post_process_enabled") || false;
  const showModelOnboardingButton = import.meta.env.DEV;

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <SettingsGroup title={t("settings.general.title")}>
        <ShortcutInput shortcutId="transcribe" grouped={true} />
        <PushToTalk descriptionMode="tooltip" grouped={true} />
        <AppLanguageSelector descriptionMode="tooltip" grouped={true} />
        <AutostartToggle descriptionMode="tooltip" grouped={true} />
        <ShowTrayIcon descriptionMode="tooltip" grouped={true} />
        {showModelOnboardingButton && (
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
        )}
      </SettingsGroup>
      <SettingsGroup title={t("settings.sound.title")}>
        <MicrophoneSelector descriptionMode="tooltip" grouped={true} />
        <MuteWhileRecording descriptionMode="tooltip" grouped={true} />
      </SettingsGroup>
      <SettingsGroup title={t("settings.advanced.groups.transcription")}>
        <TypingToolSetting descriptionMode="tooltip" grouped={true} />
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

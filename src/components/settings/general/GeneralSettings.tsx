import React from "react";
import { useTranslation } from "react-i18next";
import { MicrophoneSelector } from "../MicrophoneSelector";
import { ShortcutInput } from "../ShortcutInput";
import { RecordFullSystemAudio } from "../RecordFullSystemAudio";
import { SettingsGroup, ToggleSwitch } from "../../ui";
import { PushToTalk } from "../PushToTalk";
import { MuteWhileRecording } from "../MuteWhileRecording";
import { AlwaysOnMicrophone } from "../AlwaysOnMicrophone";
import { AutostartToggle } from "../AutostartToggle";
import { ShowTrayIcon } from "../ShowTrayIcon";
import { TypingToolSetting } from "../TypingTool";
import { PostProcessingToggle } from "../PostProcessingToggle";
import { PostProcessingSettingsApi } from "../PostProcessingSettingsApi";
import { PostProcessingSettingsAdvanced } from "../post-processing/PostProcessingSettings";
import { HistoryLimit } from "../HistoryLimit";
import { RecordingRetentionPeriodSelector } from "../RecordingRetentionPeriod";
import { AppLanguageSelector } from "../AppLanguageSelector";
import { useSettings } from "../../../hooks/useSettings";

export const GeneralSettings: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const postProcessEnabled = getSetting("post_process_enabled") || false;
  const editModeEnabled = Boolean(getSetting("edit_mode_enabled"));
  const showByokSettings = Boolean(
    getSetting("byok_enabled") || getSetting("debug_mode"),
  );

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <SettingsGroup>
        <ShortcutInput shortcutId="transcribe" grouped={true} />
        <ShortcutInput shortcutId="copy_last_transcript" grouped={true} />
        <PushToTalk descriptionMode="tooltip" grouped={true} />
        <AutostartToggle descriptionMode="tooltip" grouped={true} />
        <ShowTrayIcon descriptionMode="tooltip" grouped={true} />
        <AppLanguageSelector descriptionMode="tooltip" grouped={true} />
      </SettingsGroup>
      <SettingsGroup title={t("settings.sound.title")}>
        <MicrophoneSelector descriptionMode="tooltip" grouped={true} />
        <AlwaysOnMicrophone descriptionMode="tooltip" grouped={true} />
        <RecordFullSystemAudio descriptionMode="tooltip" grouped={true} />
        <MuteWhileRecording descriptionMode="tooltip" grouped={true} />
      </SettingsGroup>
      <SettingsGroup title={t("settings.advanced.groups.transcription")}>
        <TypingToolSetting descriptionMode="tooltip" grouped={true} />
        <ShortcutInput
          shortcutId="transcribe_with_post_process"
          grouped={true}
        />
        <PostProcessingToggle descriptionMode="tooltip" grouped={true} />
        <ShortcutInput shortcutId="edit_mode" grouped={true} />
        <ToggleSwitch
          checked={editModeEnabled}
          onChange={(checked) => updateSetting("edit_mode_enabled", checked)}
          isUpdating={isUpdating("edit_mode_enabled")}
          label="Edit Mode"
          description="Use the Edit Mode shortcut on selected text, then speak a transform instruction."
          descriptionMode="tooltip"
          grouped={true}
        />
        {postProcessEnabled && showByokSettings && (
          <PostProcessingSettingsApi />
        )}
        {postProcessEnabled && <PostProcessingSettingsAdvanced />}
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

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCcw } from "lucide-react";

import { Alert } from "../../ui/Alert";
import {
  SettingContainer,
  SettingsGroup,
  Slider,
} from "@/components/ui";
import { Button } from "../../ui/Button";
import { ResetButton } from "../../ui/ResetButton";

import { ProviderSelect } from "../PostProcessingSettingsApi/ProviderSelect";
import { BaseUrlField } from "../PostProcessingSettingsApi/BaseUrlField";
import { ApiKeyField } from "../PostProcessingSettingsApi/ApiKeyField";
import { ModelSelect } from "../PostProcessingSettingsApi/ModelSelect";
import { usePostProcessProviderState } from "../PostProcessingSettingsApi/usePostProcessProviderState";
import { useSettings } from "../../../hooks/useSettings";

const PostProcessingSettingsApiComponent: React.FC = () => {
  const { t } = useTranslation();
  const state = usePostProcessProviderState();

  return (
    <>
      <SettingContainer
        title={t("settings.postProcessing.api.provider.title")}
        description={t("settings.postProcessing.api.provider.description")}
        descriptionMode="tooltip"
        layout="horizontal"
        grouped={true}
      >
        <div className="flex items-center gap-2">
          <ProviderSelect
            options={state.providerOptions}
            value={state.selectedProviderId}
            onChange={state.handleProviderSelect}
          />
        </div>
      </SettingContainer>

      {state.isAppleProvider ? (
        state.appleIntelligenceUnavailable ? (
          <Alert variant="error" contained>
            {t("settings.postProcessing.api.appleIntelligence.unavailable")}
          </Alert>
        ) : null
      ) : (
        <>
          {state.selectedProvider?.id === "custom" && (
            <SettingContainer
              title={t("settings.postProcessing.api.baseUrl.title")}
              description={t("settings.postProcessing.api.baseUrl.description")}
              descriptionMode="tooltip"
              layout="horizontal"
              grouped={true}
            >
              <div className="flex items-center gap-2">
                <BaseUrlField
                  value={state.baseUrl}
                  onBlur={state.handleBaseUrlChange}
                  placeholder={t(
                    "settings.postProcessing.api.baseUrl.placeholder",
                  )}
                  disabled={state.isBaseUrlUpdating}
                  className="min-w-[380px]"
                />
              </div>
            </SettingContainer>
          )}

          <SettingContainer
            title={t("settings.postProcessing.api.apiKey.title")}
            description={t("settings.postProcessing.api.apiKey.description")}
            descriptionMode="tooltip"
            layout="horizontal"
            grouped={true}
          >
            <div className="flex items-center gap-2">
              <ApiKeyField
                value={state.apiKey}
                onBlur={state.handleApiKeyChange}
                placeholder={t(
                  "settings.postProcessing.api.apiKey.placeholder",
                )}
                disabled={state.isApiKeyUpdating}
                className="min-w-[320px]"
              />
            </div>
          </SettingContainer>
        </>
      )}

      {!state.isAppleProvider && (
        <SettingContainer
          title={t("settings.postProcessing.api.model.title")}
          description={
            state.isCustomProvider
              ? t("settings.postProcessing.api.model.descriptionCustom")
              : t("settings.postProcessing.api.model.descriptionDefault")
          }
          descriptionMode="tooltip"
          layout="stacked"
          grouped={true}
        >
          <div className="flex items-center gap-2">
            <ModelSelect
              value={state.model}
              options={state.modelOptions}
              disabled={state.isModelUpdating}
              isLoading={state.isFetchingModels}
              placeholder={
                state.modelOptions.length > 0
                  ? t(
                      "settings.postProcessing.api.model.placeholderWithOptions",
                    )
                  : t("settings.postProcessing.api.model.placeholderNoOptions")
              }
              onSelect={state.handleModelSelect}
              onCreate={state.handleModelCreate}
              onBlur={() => {}}
              className="flex-1 min-w-[380px]"
            />
            <ResetButton
              onClick={state.handleRefreshModels}
              disabled={state.isFetchingModels}
              ariaLabel={t("settings.postProcessing.api.model.refreshModels")}
              className="flex h-10 w-10 items-center justify-center"
            >
              <RefreshCcw
                className={`h-4 w-4 ${state.isFetchingModels ? "animate-spin" : ""}`}
              />
            </ResetButton>
          </div>
        </SettingContainer>
      )}
    </>
  );
};

export const PostProcessingSettingsApi = React.memo(
  PostProcessingSettingsApiComponent,
);
PostProcessingSettingsApi.displayName = "PostProcessingSettingsApi";

type CleaningPromptPreset = "strict" | "nuanced" | "custom";

const PRESET_OPTIONS: { value: CleaningPromptPreset; label: string; hint: string }[] = [
  { value: "strict", label: "Strict", hint: "8B+ friendly" },
  { value: "nuanced", label: "Nuanced", hint: "70B recommended" },
  { value: "custom", label: "Custom", hint: "" },
];

// Matches STRICT_CLEANING_PROMPT in settings.rs — used as the default starting point for Custom
const STRICT_PROMPT_DEFAULT = `You are a transcript cleaning assistant. Clean the transcript in the user message following these rules:
1. Fix spelling, capitalisation, and punctuation errors.
2. Convert number words to digits (twenty-five → 25, ten percent → 10%, five dollars → $5).
3. Replace spoken punctuation with symbols (period → ., comma → ,, question mark → ?).
4. Remove filler words (um, uh, "like" used as a filler).
5. Keep the original language.
6. Preserve exact meaning and word order. Do not paraphrase or reorder content.

Return only the cleaned transcript.
No explanation.`;

const PostProcessingSettingsAdvancedComponent: React.FC = () => {
  const { getSetting, updateSetting, isUpdating } = useSettings();

  const timeoutSecs = (getSetting("post_process_timeout_secs") as number) ?? 60;
  const preset = (getSetting("post_process_cleaning_prompt_preset") as CleaningPromptPreset) ?? "strict";
  const systemPrompt = (getSetting("post_process_system_prompt") as string) ?? "";

  const [draftSystemPrompt, setDraftSystemPrompt] = useState(systemPrompt);
  const isSystemPromptDirty = draftSystemPrompt !== systemPrompt;

  useEffect(() => {
    setDraftSystemPrompt(systemPrompt);
  }, [systemPrompt]);

  const handlePresetSelect = (value: CleaningPromptPreset) => {
    if (value === "custom" && !systemPrompt.trim()) {
      setDraftSystemPrompt(STRICT_PROMPT_DEFAULT);
    }
    updateSetting("post_process_cleaning_prompt_preset", value as any);
  };

  return (
    <>
      <SettingContainer
        title="Cleaning Prompt"
        description="Controls how the LLM rewrites your transcript."
        descriptionMode="tooltip"
        layout="stacked"
        grouped={true}
      >
        <div className="space-y-3">
          <div className="flex gap-2">
            {PRESET_OPTIONS.map((option) => (
              <button
                key={option.value}
                onClick={() => handlePresetSelect(option.value)}
                className={`flex flex-1 flex-col items-center px-4 py-2 rounded-md border text-sm font-medium transition-colors ${
                  preset === option.value
                    ? "border-logo-primary/70 bg-logo-primary/10 text-text"
                    : "border-mid-gray/30 bg-white/5 text-mid-gray hover:border-mid-gray/50 hover:text-text"
                }`}
              >
                <span>{option.label}</span>
                {option.hint && (
                  <span className="text-xs text-mid-gray/60 font-normal mt-0.5">{option.hint}</span>
                )}
              </button>
            ))}
          </div>

          {preset === "custom" && (
            <div className="space-y-2">
              <textarea
                value={draftSystemPrompt}
                onChange={(e) => setDraftSystemPrompt(e.target.value)}
                onMouseUp={(e) => { const t = e.target as HTMLTextAreaElement; setTimeout(() => t.select(), 0); }}
                rows={6}
                placeholder="Write your cleaning instructions here."
                className="w-full rounded-md border border-mid-gray/30 bg-white/5 px-3 py-2 text-sm text-text font-mono resize-none overflow-hidden cursor-pointer focus:cursor-text focus:outline-none focus:ring-1 focus:ring-logo-primary/50 focus:border-logo-primary/50"
              />
              {isSystemPromptDirty && (
                <div className="flex gap-2 pt-1">
                  <Button
                    onClick={() => updateSetting("post_process_system_prompt", draftSystemPrompt)}
                    variant="primary"
                    size="md"
                    disabled={isUpdating("post_process_system_prompt")}
                  >
                    Save
                  </Button>
                  <Button
                    onClick={() => setDraftSystemPrompt(systemPrompt)}
                    variant="secondary"
                    size="md"
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </SettingContainer>
      <Slider
        value={timeoutSecs}
        onChange={(val) => updateSetting("post_process_timeout_secs", Math.round(val))}
        min={5}
        max={120}
        step={1}
        label="Timeout"
        description="Maximum time to wait for post-processing before falling back to the raw transcript."
        descriptionMode="tooltip"
        grouped={true}
        formatValue={(v) => `${Math.round(v)}s`}
        disabled={isUpdating("post_process_timeout_secs")}
      />
    </>
  );
};

export const PostProcessingSettingsAdvanced = React.memo(
  PostProcessingSettingsAdvancedComponent,
);
PostProcessingSettingsAdvanced.displayName = "PostProcessingSettingsAdvanced";

export const PostProcessingSettings: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <SettingsGroup title={t("settings.postProcessing.api.title")}>
        <PostProcessingSettingsApi />
      </SettingsGroup>
      <SettingsGroup title="Advanced">
        <PostProcessingSettingsAdvanced />
      </SettingsGroup>
    </div>
  );
};

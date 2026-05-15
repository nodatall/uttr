import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useSettings } from "@/hooks/useSettings";
import { isDevPlanSimulationActive } from "@/lib/utils/premiumFeatures";
import { openUrl } from "@tauri-apps/plugin-opener";

const GROQ_KEYS_URL = "https://console.groq.com/keys";
const OPENAI_KEYS_URL = "https://platform.openai.com/api-keys";

export const ApiKeysSettings: React.FC = () => {
  const { t } = useTranslation();
  const {
    settings,
    installAccess,
    refreshInstallAccess,
    updatePostProcessApiKey,
    isUpdating,
  } = useSettings();

  const [groqApiKeyDraft, setGroqApiKeyDraft] = useState("");
  const [openAiApiKeyDraft, setOpenAiApiKeyDraft] = useState("");

  useEffect(() => {
    if (installAccess === null) {
      void refreshInstallAccess();
    }
  }, [installAccess, refreshInstallAccess]);

  const savedGroqApiKey = settings?.post_process_api_keys?.groq ?? "";
  const savedOpenAiApiKey = settings?.post_process_api_keys?.openai ?? "";

  useEffect(() => {
    setGroqApiKeyDraft(savedGroqApiKey);
  }, [savedGroqApiKey]);

  useEffect(() => {
    setOpenAiApiKeyDraft(savedOpenAiApiKey);
  }, [savedOpenAiApiKey]);

  const hasStoredGroqSecret = savedGroqApiKey.trim().length > 0;
  const hasStoredOpenAiSecret = savedOpenAiApiKey.trim().length > 0;
  const isGroqKeyUpdating = isUpdating("post_process_api_key:groq");
  const isOpenAiKeyUpdating = isUpdating("post_process_api_key:openai");
  const isPlanSimulationActive = isDevPlanSimulationActive(installAccess);

  const handleSaveGroqKey = async () => {
    await updatePostProcessApiKey("groq", groqApiKeyDraft.trim());
  };

  const handleClearGroqKey = async () => {
    await updatePostProcessApiKey("groq", "");
    setGroqApiKeyDraft("");
  };

  const handleSaveOpenAiKey = async () => {
    await updatePostProcessApiKey("openai", openAiApiKeyDraft.trim());
  };

  const handleClearOpenAiKey = async () => {
    await updatePostProcessApiKey("openai", "");
    setOpenAiApiKeyDraft("");
  };

  if (isPlanSimulationActive) {
    return null;
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div>
        <h1 className="text-[28px] font-semibold tracking-tight text-text">
          {t("settings.apiKeys.title", { defaultValue: "API Keys" })}
        </h1>
      </div>

      <div className="rounded-[20px] border border-white/8 bg-[rgba(255,255,255,0.026)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
        <h2 className="text-xl font-semibold tracking-tight text-text">
          {t("settings.apiKeys.groq.title", {
            defaultValue: "Groq Cloud",
          })}
        </h2>
        <button
          type="button"
          onClick={() => {
            void openUrl(GROQ_KEYS_URL);
          }}
          className="mt-1 cursor-pointer text-sm text-text/48 transition-colors hover:text-text/72"
        >
          {GROQ_KEYS_URL}
        </button>

        <div className="mt-5 space-y-4">
          <div className="space-y-2.5">
            <label className="text-xs font-medium uppercase tracking-[0.18em] text-text/34">
              {t("settings.apiKeys.groq.keyLabel", {
                defaultValue: "Groq API key",
              })}
            </label>
            <Input
              type="password"
              value={groqApiKeyDraft}
              onChange={(event) => setGroqApiKeyDraft(event.target.value)}
              placeholder={
                hasStoredGroqSecret
                  ? t("settings.apiKeys.groq.stored", {
                      defaultValue: "Saved key",
                    })
                  : t("settings.apiKeys.groq.placeholder", {
                      defaultValue: "gsk_...",
                    })
              }
              disabled={isGroqKeyUpdating}
              className="w-full"
            />
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              type="button"
              variant="primary-soft"
              size="sm"
              onClick={() => {
                void handleSaveGroqKey();
              }}
              disabled={
                isGroqKeyUpdating ||
                hasStoredGroqSecret ||
                groqApiKeyDraft.trim().length === 0
              }
            >
              {t("settings.apiKeys.save", { defaultValue: "Save key" })}
            </Button>
            {hasStoredGroqSecret && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  void handleClearGroqKey();
                }}
                disabled={isGroqKeyUpdating}
              >
                {t("settings.apiKeys.clear", {
                  defaultValue: "Clear key",
                })}
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-[20px] border border-white/8 bg-[rgba(255,255,255,0.026)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
        <h2 className="text-xl font-semibold tracking-tight text-text">
          {t("settings.apiKeys.openai.title", {
            defaultValue: "OpenAI",
          })}
        </h2>
        <button
          type="button"
          onClick={() => {
            void openUrl(OPENAI_KEYS_URL);
          }}
          className="mt-1 cursor-pointer text-sm text-text/48 transition-colors hover:text-text/72"
        >
          {OPENAI_KEYS_URL}
        </button>

        <div className="mt-5 space-y-4">
          <div className="space-y-2.5">
            <label className="text-xs font-medium uppercase tracking-[0.18em] text-text/34">
              {t("settings.apiKeys.openai.keyLabel", {
                defaultValue: "OpenAI API key",
              })}
            </label>
            <Input
              type="password"
              value={openAiApiKeyDraft}
              onChange={(event) => setOpenAiApiKeyDraft(event.target.value)}
              placeholder={
                hasStoredOpenAiSecret
                  ? t("settings.apiKeys.openai.stored", {
                      defaultValue: "Saved key",
                    })
                  : t("settings.apiKeys.openai.placeholder", {
                      defaultValue: "sk-...",
                    })
              }
              disabled={isOpenAiKeyUpdating}
              className="w-full"
            />
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              type="button"
              variant="primary-soft"
              size="sm"
              onClick={() => {
                void handleSaveOpenAiKey();
              }}
              disabled={
                isOpenAiKeyUpdating ||
                hasStoredOpenAiSecret ||
                openAiApiKeyDraft.trim().length === 0
              }
            >
              {t("settings.apiKeys.save", { defaultValue: "Save key" })}
            </Button>
            {hasStoredOpenAiSecret && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  void handleClearOpenAiKey();
                }}
                disabled={isOpenAiKeyUpdating}
              >
                {t("settings.apiKeys.clear", {
                  defaultValue: "Clear key",
                })}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

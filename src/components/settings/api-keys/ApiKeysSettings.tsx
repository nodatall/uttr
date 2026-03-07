import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/Input";
import { useSettings } from "@/hooks/useSettings";

export const ApiKeysSettings: React.FC = () => {
  const { t } = useTranslation();
  const { settings, updatePostProcessApiKey, isUpdating } = useSettings();

  const storedGroqApiKey = settings?.post_process_api_keys?.groq ?? "";
  const [groqApiKeyDraft, setGroqApiKeyDraft] = useState(storedGroqApiKey);
  const isGroqApiKeyUpdating = isUpdating("post_process_api_key:groq");
  const hasGroqApiKey = storedGroqApiKey.trim().length > 0;

  useEffect(() => {
    setGroqApiKeyDraft(storedGroqApiKey);
  }, [storedGroqApiKey]);

  const handleGroqApiKeyBlur = async () => {
    const trimmed = groqApiKeyDraft.trim();
    if (trimmed === storedGroqApiKey) {
      return;
    }
    await updatePostProcessApiKey("groq", trimmed);
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div className="space-y-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-text/34">
          {t("settings.apiKeys.eyebrow", { defaultValue: "Cloud access" })}
        </p>
        <h1 className="text-[28px] font-semibold tracking-tight text-text">
          {t("settings.apiKeys.title", { defaultValue: "API Keys" })}
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-text/52">
          {t("settings.apiKeys.description", {
            defaultValue:
              "Manage API keys for cloud providers used by transcription and post-processing.",
          })}
        </p>
      </div>

      <div className="rounded-[20px] border border-white/8 bg-[rgba(255,255,255,0.026)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5">
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-text/34">
              {t("settings.apiKeys.provider", { defaultValue: "Provider" })}
            </p>
            <h2 className="text-xl font-semibold tracking-tight text-text">
              {t("settings.apiKeys.groq.title", { defaultValue: "Groq Cloud" })}
            </h2>
            <p className="max-w-xl text-sm leading-relaxed text-text/50">
              {t("settings.apiKeys.groq.description", {
                defaultValue:
                  "Required for Groq cloud transcription models. This key is shared with Post Process provider settings.",
              })}
            </p>
          </div>
          <span
            className={`rounded-full border px-3 py-1.5 text-xs font-medium ${
              hasGroqApiKey
                ? "border-logo-primary/18 bg-logo-primary/10 text-logo-primary"
                : "border-white/8 bg-white/[0.04] text-text/52"
            }`}
          >
            {hasGroqApiKey
              ? t("common.connected", { defaultValue: "Connected" })
              : t("common.notConfigured", { defaultValue: "Missing key" })}
          </span>
        </div>

        <div className="mt-5 space-y-2">
          <label className="text-xs font-medium uppercase tracking-[0.18em] text-text/34">
            {t("settings.postProcessing.api.apiKey.title", {
              defaultValue: "API Key",
            })}
          </label>
          <Input
            type="password"
            value={groqApiKeyDraft}
            onChange={(event) => setGroqApiKeyDraft(event.target.value)}
            onBlur={() => {
              void handleGroqApiKeyBlur();
            }}
            placeholder={t("settings.apiKeys.groq.placeholder", {
              defaultValue: "gsk_...",
            })}
            disabled={isGroqApiKeyUpdating}
            className="w-full"
          />
          <p className="text-xs text-text/42">
            {t("settings.apiKeys.autosave", {
              defaultValue: "Saved automatically when you leave the field.",
            })}
          </p>
        </div>
      </div>
    </div>
  );
};

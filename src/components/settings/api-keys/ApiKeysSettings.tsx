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
    <div className="max-w-3xl w-full mx-auto space-y-4">
      <div className="mb-4">
        <h1 className="text-xl font-semibold mb-2">
          {t("settings.apiKeys.title", { defaultValue: "API Keys" })}
        </h1>
        <p className="text-sm text-text/60">
          {t("settings.apiKeys.description", {
            defaultValue:
              "Manage API keys for cloud providers used by transcription and post-processing.",
          })}
        </p>
      </div>

      <div className="rounded-xl border border-mid-gray/30 bg-mid-gray/10 px-4 py-3 space-y-2">
        <h2 className="text-sm font-semibold text-text">
          {t("settings.apiKeys.groq.title", { defaultValue: "Groq Cloud" })}
        </h2>
        <p className="text-xs text-text/60">
          {t("settings.apiKeys.groq.description", {
            defaultValue:
              "Required for Groq cloud transcription models. This key is shared with Post Process provider settings.",
          })}
        </p>
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
      </div>
    </div>
  );
};

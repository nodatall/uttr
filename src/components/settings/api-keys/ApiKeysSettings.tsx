import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useSettings } from "@/hooks/useSettings";
import { isDevPlanSimulationActive } from "@/lib/utils/premiumFeatures";

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

  useEffect(() => {
    if (installAccess === null) {
      void refreshInstallAccess();
    }
  }, [installAccess, refreshInstallAccess]);

  const savedGroqApiKey = settings?.post_process_api_keys?.groq ?? "";

  useEffect(() => {
    setGroqApiKeyDraft(savedGroqApiKey);
  }, [savedGroqApiKey]);

  const hasStoredSecret = installAccess?.has_byok_secret ?? false;
  const isKeyUpdating = isUpdating("post_process_api_key:groq");
  const isBusy = isKeyUpdating;
  const isPlanSimulationActive = isDevPlanSimulationActive(installAccess);

  const handleSaveKey = async () => {
    await updatePostProcessApiKey("groq", groqApiKeyDraft.trim());
  };

  const handleClearKey = async () => {
    await updatePostProcessApiKey("groq", "");
    setGroqApiKeyDraft("");
  };

  if (isPlanSimulationActive) {
    return null;
  }

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
              "Add your Groq API key to use your own cloud transcription access.",
          })}
        </p>
      </div>

      <div className="rounded-[20px] border border-white/8 bg-[rgba(255,255,255,0.026)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5">
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-text/34">
              {t("settings.apiKeys.groq.sectionLabel", {
                defaultValue: "Groq",
              })}
            </p>
            <h2 className="text-xl font-semibold tracking-tight text-text">
              {t("settings.apiKeys.groq.title", {
                defaultValue: "Groq API key",
              })}
            </h2>
            <p className="max-w-xl text-sm leading-relaxed text-text/50">
              {t("settings.apiKeys.groq.description", {
                defaultValue:
                  "Use your own Groq key for transcription. Save a new key here any time to replace the current one.",
              })}
            </p>
          </div>
          <span className="inline-flex items-center rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-text/62">
            {hasStoredSecret
              ? t("settings.apiKeys.groq.configured", {
                  defaultValue: "Configured",
                })
              : t("settings.apiKeys.groq.notConfigured", {
                  defaultValue: "Not configured",
                })}
          </span>
        </div>

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
                hasStoredSecret
                  ? t("settings.apiKeys.groq.stored", {
                      defaultValue: "Saved key",
                    })
                  : t("settings.apiKeys.groq.placeholder", {
                      defaultValue: "gsk_...",
                    })
              }
              disabled={isBusy}
              className="w-full"
            />
            <p className="text-xs leading-relaxed text-text/42">
              {t("settings.apiKeys.groq.storageNote", {
                defaultValue:
                  "The saved key stays in this field so you can inspect, replace, or clear it.",
              })}
            </p>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              type="button"
              variant="primary-soft"
              size="sm"
              onClick={() => {
                void handleSaveKey();
              }}
              disabled={isBusy || groqApiKeyDraft.trim().length === 0}
            >
              {t("settings.apiKeys.save", { defaultValue: "Save key" })}
            </Button>
            {hasStoredSecret && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  void handleClearKey();
                }}
                disabled={isBusy}
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

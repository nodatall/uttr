import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, CheckCircle2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { useSettings } from "@/hooks/useSettings";

const validationStyles = {
  unknown: "border-white/8 bg-white/[0.03] text-text/62",
  valid: "border-logo-primary/18 bg-logo-primary/10 text-logo-primary",
  invalid: "border-amber-400/20 bg-amber-400/10 text-amber-200",
} as const;

export const ApiKeysSettings: React.FC = () => {
  const { t } = useTranslation();
  const {
    settings,
    installAccess,
    updatePostProcessApiKey,
    validateByokGroqKey,
    updateSetting,
    isUpdating,
  } = useSettings();

  const [groqApiKeyDraft, setGroqApiKeyDraft] = useState("");

  useEffect(() => {
    setGroqApiKeyDraft("");
  }, [installAccess?.has_byok_secret]);

  const byokEnabled = settings?.byok_enabled ?? false;
  const validationState = settings?.byok_validation_state ?? "unknown";
  const hasStoredSecret = installAccess?.has_byok_secret ?? false;
  const isEnabledUpdating = isUpdating("byok_enabled");
  const isKeyUpdating = isUpdating("post_process_api_key:groq");
  const isValidationUpdating = isUpdating("byok_validation:groq");
  const isBusy = isEnabledUpdating || isKeyUpdating || isValidationUpdating;
  const canEnableByok = hasStoredSecret && validationState === "valid";

  const validationLabel = {
    unknown: t("settings.apiKeys.validation.unknown", {
      defaultValue: "Not validated",
    }),
    valid: t("settings.apiKeys.validation.valid", {
      defaultValue: "Validated",
    }),
    invalid: t("settings.apiKeys.validation.invalid", {
      defaultValue: "Invalid",
    }),
  }[validationState];

  const validationIcon = {
    unknown: ShieldAlert,
    valid: CheckCircle2,
    invalid: AlertCircle,
  }[validationState];
  const ValidationIcon = validationIcon;

  const handleSaveKey = async () => {
    await updatePostProcessApiKey("groq", groqApiKeyDraft.trim());
  };

  const handleClearKey = async () => {
    await updatePostProcessApiKey("groq", "");
    setGroqApiKeyDraft("");
  };

  const handleValidate = async () => {
    await validateByokGroqKey();
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div className="space-y-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-text/34">
          {t("settings.byok.eyebrow", { defaultValue: "Hidden access" })}
        </p>
        <h1 className="text-[28px] font-semibold tracking-tight text-text">
          {t("settings.byok.title", { defaultValue: "BYOK controls" })}
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-text/52">
          {t("settings.byok.description", {
            defaultValue:
              "Manage the optional Groq Bring Your Own Key path. The key is stored securely and only used when BYOK is enabled and validated.",
          })}
        </p>
      </div>

      <div className="rounded-[20px] border border-white/8 bg-[rgba(255,255,255,0.026)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5">
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-text/34">
              {t("settings.byok.groq.sectionLabel", {
                defaultValue: "Groq BYOK",
              })}
            </p>
            <h2 className="text-xl font-semibold tracking-tight text-text">
              {t("settings.byok.groq.title", {
                defaultValue: "Direct Groq routing",
              })}
            </h2>
            <p className="max-w-xl text-sm leading-relaxed text-text/50">
              {t("settings.byok.groq.description", {
                defaultValue:
                  "Unlock the key entry, save the secret, validate it, and then enable BYOK to bypass subscription gating when the key is valid.",
              })}
            </p>
          </div>
          <span
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium ${validationStyles[validationState]}`}
          >
            <ValidationIcon className="h-3.5 w-3.5" />
            {validationLabel}
          </span>
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(260px,0.8fr)]">
          <div className="space-y-2.5">
            <label className="text-xs font-medium uppercase tracking-[0.18em] text-text/34">
              {t("settings.byok.groq.keyLabel", {
                defaultValue: "Groq API key",
              })}
            </label>
            <Input
              type="password"
              value={groqApiKeyDraft}
              onChange={(event) => setGroqApiKeyDraft(event.target.value)}
              placeholder={
                hasStoredSecret
                  ? t("settings.byok.groq.stored", {
                      defaultValue: "Secret stored in Stronghold",
                    })
                  : t("settings.byok.groq.placeholder", {
                      defaultValue: "gsk_...",
                    })
              }
              disabled={isBusy}
              className="w-full"
            />
            <p className="text-xs leading-relaxed text-text/42">
              {t("settings.byok.groq.storageNote", {
                defaultValue:
                  "The key is not shown after saving. Replace it here, or clear it to remove the stored secret.",
              })}
            </p>
          </div>

          <div className="space-y-3 rounded-[18px] border border-white/7 bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-[0.18em] text-text/34">
                  {t("settings.byok.status", { defaultValue: "Status" })}
                </p>
                <p className="text-sm text-text/70">
                  {hasStoredSecret
                    ? t("settings.byok.secretStored", {
                        defaultValue: "Secret stored in Stronghold",
                      })
                    : t("settings.byok.noSecret", {
                        defaultValue: "No stored secret",
                      })}
                </p>
              </div>
              <span
                className={`rounded-full border px-3 py-1 text-xs font-medium ${
                  byokEnabled
                    ? "border-logo-primary/18 bg-logo-primary/10 text-logo-primary"
                    : "border-white/8 bg-white/[0.03] text-text/52"
                }`}
              >
                {byokEnabled
                  ? t("common.enabled", { defaultValue: "Enabled" })
                  : t("common.disabled", { defaultValue: "Disabled" })}
              </span>
            </div>

            <ToggleSwitch
              checked={byokEnabled}
              onChange={(checked) => {
                void updateSetting("byok_enabled", checked);
              }}
              disabled={isBusy || (!byokEnabled && !canEnableByok)}
              isUpdating={isEnabledUpdating}
              label={t("settings.byok.enableLabel", {
                defaultValue: "Enable BYOK",
              })}
              description={t("settings.byok.enableDescription", {
                defaultValue:
                  "Use the stored Groq key for direct routing only after the key validates successfully.",
              })}
              descriptionMode="inline"
              grouped
            />
            {!canEnableByok && (
              <p className="text-xs leading-relaxed text-text/42">
                {t("settings.byok.enableGuard", {
                  defaultValue:
                    "Save and validate a Groq key before enabling direct BYOK routing.",
                })}
              </p>
            )}

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
                {t("settings.byok.save", { defaultValue: "Save key" })}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  void handleValidate().catch((error) => {
                    console.error("Failed to validate Groq BYOK key:", error);
                    toast.error(
                      t("settings.byok.validateFailed", {
                        defaultValue: "Failed to validate the Groq key.",
                      }),
                    );
                  });
                }}
                disabled={isBusy || !hasStoredSecret}
              >
                {t("settings.byok.validate", {
                  defaultValue: "Validate key",
                })}
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
                  {t("settings.byok.clear", {
                    defaultValue: "Clear key",
                  })}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

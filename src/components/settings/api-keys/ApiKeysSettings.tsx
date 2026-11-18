import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useSettings } from "@/hooks/useSettings";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

const providers = [
  {
    id: "groq",
    name: "Groq Cloud",
    providerName: "Groq",
    keysUrl: "https://console.groq.com/keys",
    placeholder: "gsk_...",
  },
  {
    id: "openai",
    name: "OpenAI",
    providerName: "OpenAI",
    keysUrl: "https://platform.openai.com/api-keys",
    placeholder: "sk-...",
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    providerName: "ElevenLabs",
    keysUrl: "https://elevenlabs.io/app/developers/api-keys",
    placeholder: "ElevenLabs API key",
  },
] as const;

const ProviderKeyField = ({
  id,
  name,
  providerName,
  keysUrl,
  placeholder,
}: (typeof providers)[number]) => {
  const { t } = useTranslation();
  const { postProcessApiKeyStatuses, updatePostProcessApiKey, isUpdating } =
    useSettings();
  const [draft, setDraft] = useState("");
  const saved = postProcessApiKeyStatuses[id] ?? false;
  const updating = isUpdating(`post_process_api_key:${id}`);

  const updateKey = async (value: string) => {
    try {
      await updatePostProcessApiKey(id, value);
      setDraft("");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("settings.apiKeys.saveFailed", {
              defaultValue: "Unable to update API key.",
            }),
      );
    }
  };

  return (
    <section
      aria-labelledby={`title-${id}`}
      className="rounded-[20px] border border-white/8 bg-[rgba(255,255,255,0.026)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]"
    >
      <h2
        id={`title-${id}`}
        className="text-xl font-semibold tracking-tight text-text"
      >
        {t(`settings.apiKeys.${id}.title`, {
          defaultValue: name,
        })}
      </h2>
      <button
        type="button"
        onClick={() => {
          void openUrl(keysUrl);
        }}
        className="mt-1 cursor-pointer text-sm text-text/48 transition-colors hover:text-text/72"
      >
        {keysUrl}
      </button>

      <div className="mt-5 space-y-4">
        <div className="space-y-2.5">
          <label
            htmlFor={`api-key-${id}`}
            className="text-xs font-medium uppercase tracking-[0.18em] text-text/34"
          >
            {t(`settings.apiKeys.${id}.keyLabel`, {
              defaultValue: `${providerName} API key`,
            })}
          </label>
          <Input
            id={`api-key-${id}`}
            autoComplete="off"
            type="password"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={
              saved
                ? t(`settings.apiKeys.${id}.stored`, {
                    defaultValue: "Saved key",
                  })
                : t(`settings.apiKeys.${id}.placeholder`, {
                    defaultValue: placeholder,
                  })
            }
            disabled={updating}
            className="w-full"
          />
        </div>

        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            type="button"
            variant="primary-soft"
            size="sm"
            onClick={() => {
              void updateKey(draft.trim());
            }}
            disabled={updating || saved || draft.trim().length === 0}
          >
            {t("settings.apiKeys.save", { defaultValue: "Save key" })}
          </Button>
          {saved && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                void updateKey("");
              }}
              disabled={updating}
            >
              {t("settings.apiKeys.clear", {
                defaultValue: "Clear key",
              })}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
};

export const ApiKeysSettings: React.FC = () => {
  const { t } = useTranslation();
  const { installAccess, refreshInstallAccess } = useSettings();
  useEffect(() => {
    if (installAccess === null) {
      void refreshInstallAccess();
    }
  }, [installAccess, refreshInstallAccess]);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div>
        <h1 className="text-[28px] font-semibold tracking-tight text-text">
          {t("settings.apiKeys.title", { defaultValue: "API Keys" })}
        </h1>
      </div>
      {providers.map((provider) => (
        <ProviderKeyField key={provider.id} {...provider} />
      ))}
    </div>
  );
};

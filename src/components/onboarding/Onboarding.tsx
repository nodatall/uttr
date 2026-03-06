import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { ModelInfo } from "@/bindings";
import WindowDragRegion from "@/components/ui/WindowDragRegion";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import type { ModelCardStatus } from "./ModelCard";
import ModelCard from "./ModelCard";
import { useModelStore } from "../../stores/modelStore";
import { useSettings } from "@/hooks/useSettings";

interface OnboardingProps {
  onModelSelected: () => void;
}

const isCloudModel = (modelId: string): boolean => modelId.startsWith("groq-");

const Onboarding: React.FC<OnboardingProps> = ({ onModelSelected }) => {
  const { t } = useTranslation();
  const {
    models,
    currentModel,
    downloadModel,
    selectModel,
    downloadingModels,
    extractingModels,
    downloadProgress,
    downloadStats,
  } = useModelStore();
  const { settings, updatePostProcessApiKey, isUpdating } = useSettings();
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const storedGroqApiKey = settings?.post_process_api_keys?.groq ?? "";
  const [groqApiKeyDraft, setGroqApiKeyDraft] = useState(storedGroqApiKey);
  const isGroqApiKeyUpdating = isUpdating("post_process_api_key:groq");

  const isDownloading = selectedModelId !== null;
  const hasAnyDownloadedModel = models.some((model) => model.is_downloaded);
  const canContinue = Boolean(currentModel) || hasAnyDownloadedModel;

  useEffect(() => {
    setGroqApiKeyDraft(storedGroqApiKey);
  }, [storedGroqApiKey]);

  // Watch for the selected model to finish downloading + extracting
  useEffect(() => {
    if (!selectedModelId) return;

    const model = models.find((m) => m.id === selectedModelId);
    if (model?.is_downloaded) {
      const modelIdToSelect = selectedModelId;
      // Prevent repeated selection attempts while model list/events are still updating.
      setSelectedModelId(null);
      // Model is ready — select it and transition
      selectModel(modelIdToSelect).then((success) => {
        if (success) {
          onModelSelected();
        } else {
          toast.error(
            t("onboarding.errors.selectModel", {
              defaultValue: "Failed to select model.",
            }),
          );
          setSelectedModelId(null);
        }
      });
    }
  }, [
    selectedModelId,
    models,
    downloadingModels,
    extractingModels,
    selectModel,
    onModelSelected,
  ]);

  const handleDownloadModel = async (modelId: string) => {
    if (isCloudModel(modelId)) {
      if (!storedGroqApiKey.trim()) {
        toast.error(
          t("onboarding.groq.missingKey", {
            defaultValue:
              "Add your Groq API key before selecting a Groq cloud model.",
          }),
        );
        setSelectedModelId(null);
        return;
      }
      const success = await selectModel(modelId);
      if (success) {
        onModelSelected();
      } else {
        toast.error(
          t("onboarding.errors.selectModel", {
            defaultValue: "Failed to select model.",
          }),
        );
        setSelectedModelId(null);
      }
      return;
    }

    setSelectedModelId(modelId);

    const success = await downloadModel(modelId);
    if (!success) {
      toast.error(t("onboarding.downloadFailed"));
      setSelectedModelId(null);
    }
  };

  const handleGroqApiKeyBlur = async () => {
    const trimmed = groqApiKeyDraft.trim();
    if (trimmed === storedGroqApiKey) {
      return;
    }
    await updatePostProcessApiKey("groq", trimmed);
  };

  const handleContinue = async () => {
    if (currentModel) {
      onModelSelected();
      return;
    }

    const downloadedModel = models.find((model) => model.is_downloaded);
    if (!downloadedModel) {
      toast.error(
        t("onboarding.continueMissingModel", {
          defaultValue: "Download a model first, then continue.",
        }),
      );
      return;
    }

    const success = await selectModel(downloadedModel.id);
    if (!success) {
      toast.error(
        t("onboarding.errors.selectModel", {
          defaultValue: "Failed to select model.",
        }),
      );
      return;
    }

    onModelSelected();
  };

  const getModelStatus = (modelId: string): ModelCardStatus => {
    if (modelId in extractingModels) return "extracting";
    if (modelId in downloadingModels) return "downloading";
    return "downloadable";
  };

  const getModelDownloadProgress = (modelId: string): number | undefined => {
    return downloadProgress[modelId]?.percentage;
  };

  const getModelDownloadSpeed = (modelId: string): number | undefined => {
    return downloadStats[modelId]?.speed;
  };

  return (
    <div className="relative h-screen w-screen flex flex-col inset-0">
      <WindowDragRegion />
      <div className="flex-1 flex flex-col p-6 gap-4">
        <div className="flex flex-col items-center gap-2 shrink-0 text-center">
          {/* eslint-disable-next-line i18next/no-literal-string */}
          <p className="text-[11px] tracking-[0.3em] uppercase text-logo-primary/70">
            Uttr
          </p>
          <p className="text-text/70 max-w-md font-medium mx-auto">
            {t("onboarding.subtitle")}
          </p>
        </div>

        <div className="max-w-[600px] w-full mx-auto text-center flex-1 flex flex-col min-h-0">
          <div className="flex flex-col gap-4 pb-6">
            <div className="rounded-xl border border-mid-gray/30 bg-mid-gray/10 px-4 py-3 space-y-2 text-left">
              <h2 className="text-sm font-semibold text-text">
                {t("onboarding.groq.title", { defaultValue: "Groq API Key" })}
              </h2>
              <p className="text-xs text-text/60">
                {t("onboarding.groq.description", {
                  defaultValue:
                    "Required only for Groq cloud models. You can also add this later in API Keys.",
                })}
              </p>
              <Input
                type="password"
                value={groqApiKeyDraft}
                onChange={(event) => setGroqApiKeyDraft(event.target.value)}
                onBlur={() => {
                  void handleGroqApiKeyBlur();
                }}
                placeholder={t("onboarding.groq.placeholder", {
                  defaultValue: "gsk_...",
                })}
                disabled={isGroqApiKeyUpdating}
                className="w-full"
              />
            </div>

            {models
              .filter((m: ModelInfo) => !m.is_downloaded)
              .filter((model: ModelInfo) => model.is_recommended)
              .map((model: ModelInfo) => (
                <ModelCard
                  key={model.id}
                  model={model}
                  variant="featured"
                  status={getModelStatus(model.id)}
                  disabled={isDownloading}
                  onSelect={handleDownloadModel}
                  onDownload={handleDownloadModel}
                  downloadProgress={getModelDownloadProgress(model.id)}
                  downloadSpeed={getModelDownloadSpeed(model.id)}
                />
              ))}

            {models
              .filter((m: ModelInfo) => !m.is_downloaded)
              .filter((model: ModelInfo) => !model.is_recommended)
              .sort(
                (a: ModelInfo, b: ModelInfo) =>
                  Number(a.size_mb) - Number(b.size_mb),
              )
              .map((model: ModelInfo) => (
                <ModelCard
                  key={model.id}
                  model={model}
                  status={getModelStatus(model.id)}
                  disabled={isDownloading}
                  onSelect={handleDownloadModel}
                  onDownload={handleDownloadModel}
                  downloadProgress={getModelDownloadProgress(model.id)}
                  downloadSpeed={getModelDownloadSpeed(model.id)}
                />
              ))}

            <div className="pt-2 flex justify-end">
              <Button
                variant="primary-soft"
                onClick={() => {
                  void handleContinue();
                }}
                disabled={isGroqApiKeyUpdating}
              >
                {t("onboarding.continue", { defaultValue: "Continue" })}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Onboarding;

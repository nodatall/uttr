import { useCallback, useEffect, useRef, useState, type FC } from "react";
import { useTranslation } from "react-i18next";
import { Cloud, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import WindowDragRegion from "@/components/ui/WindowDragRegion";
import { Button } from "@/components/ui/Button";
import { useModelStore } from "../../stores/modelStore";

interface OnboardingProps {
  onModelSelected: () => void;
}

const DEFAULT_CLOUD_MODEL_ID = "groq-whisper-large-v3";
const BACKGROUND_MODEL_ID = "parakeet-tdt-0.6b-v3";

const Onboarding: FC<OnboardingProps> = ({ onModelSelected }) => {
  const { t } = useTranslation();
  const {
    currentModel,
    selectModel,
    prefetchModel,
    downloadProgress,
    extractingModels,
    models,
  } = useModelStore();
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const didStartRef = useRef(false);

  const backgroundProgress = downloadProgress[BACKGROUND_MODEL_ID];
  const backgroundModel = models.find(
    (model) => model.id === BACKGROUND_MODEL_ID,
  );
  const cloudModel = models.find(
    (model) => model.id === DEFAULT_CLOUD_MODEL_ID,
  );

  const startImmediateUse = useCallback(async () => {
    if (currentModel.trim().length > 0) {
      onModelSelected();
      return;
    }

    setIsBootstrapping(true);
    setBootstrapError(null);

    void prefetchModel(BACKGROUND_MODEL_ID).then((success) => {
      if (!success) {
        toast.error(
          t("onboarding.backgroundDownloadFailed", {
            defaultValue:
              "Parakeet V3 could not start downloading in the background.",
          }),
        );
      }
    });

    const success = await selectModel(DEFAULT_CLOUD_MODEL_ID);
    if (success) {
      onModelSelected();
      return;
    }

    const errorMessage = t("onboarding.errors.selectModel", {
      defaultValue: "Failed to prepare the default cloud model.",
    });
    setBootstrapError(errorMessage);
    setIsBootstrapping(false);
    toast.error(errorMessage);
  }, [currentModel, onModelSelected, prefetchModel, selectModel, t]);

  useEffect(() => {
    if (didStartRef.current) {
      return;
    }
    didStartRef.current = true;
    void startImmediateUse();
    // startImmediateUse intentionally depends on current model state so retries pick up the latest store value.
  }, [startImmediateUse]);

  const backgroundStatus = (() => {
    if (extractingModels[BACKGROUND_MODEL_ID]) {
      return t("onboarding.background.extracting", {
        defaultValue: "Finishing the offline model setup in the background.",
      });
    }

    if (backgroundProgress) {
      const percentage = Math.max(
        0,
        Math.min(100, Math.round(backgroundProgress.percentage)),
      );
      return t("onboarding.background.downloading", {
        defaultValue: `Downloading Parakeet V3 in the background (${percentage}%).`,
      });
    }

    if (backgroundModel?.is_downloading) {
      return t("onboarding.background.preparing", {
        defaultValue: "Preparing the background download.",
      });
    }

    return t("onboarding.background.ready", {
      defaultValue: "Background download will start automatically.",
    });
  })();

  return (
    <div className="relative flex h-screen w-screen flex-col inset-0">
      <WindowDragRegion />
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-[680px] rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(9,14,24,0.98),rgba(7,12,20,0.95))] px-6 py-7 shadow-[0_24px_64px_rgba(0,0,0,0.28)]">
          <div className="flex flex-col gap-6">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-2">
                {/* eslint-disable-next-line i18next/no-literal-string */}
                <p className="text-[11px] uppercase tracking-[0.32em] text-logo-primary/70">
                  Uttr
                </p>
                <h1 className="text-2xl font-semibold tracking-tight text-text">
                  {t("onboarding.immediate.title", {
                    defaultValue: "Ready to start right away.",
                  })}
                </h1>
                <p className="max-w-xl text-sm leading-relaxed text-text/66">
                  {t("onboarding.immediate.subtitle", {
                    defaultValue:
                      "Uttr is selecting the cloud transcription model now and will keep Parakeet V3 downloading in the background for offline use.",
                  })}
                </p>
              </div>

              <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-logo-primary/16 bg-logo-primary/10 text-logo-primary">
                <Cloud className="h-5 w-5" />
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-4">
                <div className="flex items-center gap-2 text-sm font-medium text-text">
                  <Cloud className="h-4 w-4 text-logo-primary" />
                  {t("onboarding.immediate.cloudTitle", {
                    defaultValue: "Cloud transcription",
                  })}
                </div>
                <p className="mt-2 text-sm leading-relaxed text-text/60">
                  {t("onboarding.immediate.cloudBody", {
                    defaultValue:
                      "The default cloud model is being enabled automatically, so no key or model choice is required up front.",
                  })}
                </p>
                <p className="mt-2 text-xs uppercase tracking-[0.24em] text-text/42">
                  {cloudModel?.name || DEFAULT_CLOUD_MODEL_ID}
                </p>
              </div>

              <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-4">
                <div className="flex items-center gap-2 text-sm font-medium text-text">
                  <Download className="h-4 w-4 text-logo-primary" />
                  {t("onboarding.immediate.downloadTitle", {
                    defaultValue: "Offline model setup",
                  })}
                </div>
                <p className="mt-2 text-sm leading-relaxed text-text/60">
                  {backgroundStatus}
                </p>
                {backgroundProgress && (
                  <div className="mt-3">
                    <div className="h-1.5 overflow-hidden rounded-full bg-white/8">
                      <div
                        className="h-full rounded-full bg-logo-primary transition-all duration-300"
                        style={{ width: `${backgroundProgress.percentage}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between gap-4 rounded-2xl border border-mid-gray/20 bg-mid-gray/10 px-4 py-3">
              <div className="flex items-center gap-3">
                {isBootstrapping ? (
                  <Loader2 className="h-4 w-4 animate-spin text-logo-primary" />
                ) : (
                  <Cloud className="h-4 w-4 text-logo-primary" />
                )}
                <div>
                  <p className="text-sm font-medium text-text">
                    {isBootstrapping
                      ? t("onboarding.immediate.starting", {
                          defaultValue: "Setting up your first session.",
                        })
                      : t("onboarding.immediate.ready", {
                          defaultValue: "Ready to continue.",
                        })}
                  </p>
                  <p className="text-xs text-text/55">
                    {bootstrapError ||
                      t("onboarding.immediate.detail", {
                        defaultValue:
                          "The app will continue in the background while setup finishes.",
                      })}
                  </p>
                </div>
              </div>

              {bootstrapError && (
                <Button
                  variant="primary-soft"
                  onClick={() => {
                    void startImmediateUse();
                  }}
                >
                  {t("common.retry", { defaultValue: "Retry" })}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Onboarding;

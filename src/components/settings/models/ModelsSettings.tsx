import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ask } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { ChevronDown, Globe } from "lucide-react";
import type { ModelCardStatus } from "@/components/onboarding";
import { ModelCard } from "@/components/onboarding";
import { useModelStore } from "@/stores/modelStore";
import { useSettings } from "@/hooks/useSettings";
import { LANGUAGES } from "@/lib/constants/languages.ts";
import type { ModelInfo } from "@/bindings";

// check if model supports a language based on its supported_languages list
const modelSupportsLanguage = (model: ModelInfo, langCode: string): boolean => {
  return model.supported_languages.includes(langCode);
};

const isCloudModel = (modelId: string): boolean => modelId.startsWith("groq-");

export const ModelsSettings: React.FC = () => {
  const { t } = useTranslation();
  const [switchingModelId, setSwitchingModelId] = useState<string | null>(null);
  const [languageFilter, setLanguageFilter] = useState("all");
  const [languageDropdownOpen, setLanguageDropdownOpen] = useState(false);
  const [languageSearch, setLanguageSearch] = useState("");
  const languageDropdownRef = useRef<HTMLDivElement>(null);
  const languageSearchInputRef = useRef<HTMLInputElement>(null);
  const {
    models,
    currentModel,
    downloadingModels,
    downloadProgress,
    downloadStats,
    extractingModels,
    loading,
    downloadModel,
    cancelDownload,
    selectModel,
    deleteModel,
  } = useModelStore();
  const { settings, isUpdating } = useSettings();
  const groqApiKey = settings?.post_process_api_keys?.groq ?? "";
  const isGroqApiKeyUpdating = isUpdating("post_process_api_key:groq");
  const hasGroqApiKey = groqApiKey.trim().length > 0;
  const currentModelInfo = useMemo(
    () => models.find((model: ModelInfo) => model.id === currentModel) ?? null,
    [models, currentModel],
  );

  // click outside handler for language dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        languageDropdownRef.current &&
        !languageDropdownRef.current.contains(event.target as Node)
      ) {
        setLanguageDropdownOpen(false);
        setLanguageSearch("");
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // focus search input when dropdown opens
  useEffect(() => {
    if (languageDropdownOpen && languageSearchInputRef.current) {
      languageSearchInputRef.current.focus();
    }
  }, [languageDropdownOpen]);

  // filtered languages for dropdown (exclude "auto")
  const filteredLanguages = useMemo(() => {
    return LANGUAGES.filter(
      (lang) =>
        lang.value !== "auto" &&
        lang.label.toLowerCase().includes(languageSearch.toLowerCase()),
    );
  }, [languageSearch]);

  // Get selected language label
  const selectedLanguageLabel = useMemo(() => {
    if (languageFilter === "all") {
      return t("settings.models.filters.allLanguages");
    }
    return LANGUAGES.find((lang) => lang.value === languageFilter)?.label || "";
  }, [languageFilter, t]);

  const getModelStatus = (modelId: string): ModelCardStatus => {
    if (modelId in extractingModels) {
      return "extracting";
    }
    if (modelId in downloadingModels) {
      return "downloading";
    }
    if (switchingModelId === modelId) {
      return "switching";
    }
    if (modelId === currentModel) {
      return "active";
    }
    if (isCloudModel(modelId)) {
      return "available";
    }
    const model = models.find((m: ModelInfo) => m.id === modelId);
    if (model?.is_downloaded) {
      return "available";
    }
    return "downloadable";
  };

  const getDownloadProgress = (modelId: string): number | undefined => {
    const progress = downloadProgress[modelId];
    return progress?.percentage;
  };

  const getDownloadSpeed = (modelId: string): number | undefined => {
    const stats = downloadStats[modelId];
    return stats?.speed;
  };

  const handleModelSelect = async (modelId: string) => {
    if (modelId.startsWith("groq-")) {
      if (!groqApiKey.trim()) {
        toast.error(
          t("settings.models.groq.missingKey", {
            defaultValue:
              "Add your Groq API key in API Keys before selecting a Groq model.",
          }),
        );
        return;
      }
    }

    setSwitchingModelId(modelId);
    try {
      const success = await selectModel(modelId);
      if (!success) {
        toast.error(
          t("onboarding.errors.selectModel", {
            defaultValue: "Failed to switch model.",
          }),
        );
      }
    } finally {
      setSwitchingModelId(null);
    }
  };

  const handleModelDownload = async (modelId: string) => {
    await downloadModel(modelId);
  };

  const handleModelDelete = async (modelId: string) => {
    const model = models.find((m: ModelInfo) => m.id === modelId);
    const modelName = model?.name || modelId;
    const isActive = modelId === currentModel;

    const confirmed = await ask(
      isActive
        ? t("settings.models.deleteActiveConfirm", { modelName })
        : t("settings.models.deleteConfirm", { modelName }),
      {
        title: t("settings.models.deleteTitle"),
        kind: "warning",
      },
    );

    if (confirmed) {
      try {
        await deleteModel(modelId);
      } catch (err) {
        console.error(`Failed to delete model ${modelId}:`, err);
      }
    }
  };

  const handleModelCancel = async (modelId: string) => {
    try {
      await cancelDownload(modelId);
    } catch (err) {
      console.error(`Failed to cancel download for ${modelId}:`, err);
    }
  };

  const cloudModels = useMemo(() => {
    return models.filter((model: ModelInfo) => isCloudModel(model.id));
  }, [models]);

  // Filter local models based on language filter
  const filteredLocalModels = useMemo(() => {
    return models.filter((model: ModelInfo) => {
      if (isCloudModel(model.id)) return false;
      if (languageFilter !== "all") {
        if (!modelSupportsLanguage(model, languageFilter)) return false;
      }
      return true;
    });
  }, [models, languageFilter]);

  // Split filtered local models into downloaded (including custom) and available sections
  const { downloadedModels, availableModels } = useMemo(() => {
    const downloaded: ModelInfo[] = [];
    const available: ModelInfo[] = [];

    for (const model of filteredLocalModels) {
      if (
        model.is_custom ||
        model.is_downloaded ||
        model.id in downloadingModels ||
        model.id in extractingModels
      ) {
        downloaded.push(model);
      } else {
        available.push(model);
      }
    }

    // Sort: active model first, then non-custom, then custom at the bottom
    downloaded.sort((a, b) => {
      if (a.id === currentModel) return -1;
      if (b.id === currentModel) return 1;
      if (a.is_custom !== b.is_custom) return a.is_custom ? 1 : -1;
      return 0;
    });

    return {
      downloadedModels: downloaded,
      availableModels: available,
    };
  }, [filteredLocalModels, downloadingModels, extractingModels, currentModel]);

  if (loading) {
    return (
      <div className="max-w-3xl w-full mx-auto">
        <div className="flex items-center justify-center py-16">
          <div className="w-8 h-8 border-2 border-logo-primary border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-text/34">
            {t("settings.models.eyebrow", { defaultValue: "Model library" })}
          </p>
          <h1 className="text-[28px] font-semibold tracking-tight text-text">
            {t("settings.models.title")}
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-text/52">
            {t("settings.models.description")}
          </p>
        </div>
        {currentModelInfo && (
          <div className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-2 text-sm text-text/62">
            <span className="mr-2 text-text/40">
              {t("modelSelector.active", { defaultValue: "Active" })}
            </span>
            <span className="font-medium text-text/88">{currentModelInfo.name}</span>
          </div>
        )}
      </div>
      {filteredLocalModels.length > 0 ? (
        <div className="space-y-7">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-text/34">
                  {t("settings.models.yourModels")}
                </h2>
              </div>
              <div className="relative" ref={languageDropdownRef}>
                <button
                  type="button"
                  onClick={() => setLanguageDropdownOpen(!languageDropdownOpen)}
                  className={`flex items-center gap-2 rounded-full border px-3 py-2 text-sm transition-colors ${
                    languageFilter !== "all"
                      ? "border-logo-primary/18 bg-logo-primary/10 text-text"
                      : "border-white/8 bg-white/[0.03] text-text/62 hover:bg-white/[0.05]"
                  }`}
                >
                  <Globe className="h-3.5 w-3.5" />
                  <span className="max-w-[120px] truncate">
                    {selectedLanguageLabel}
                  </span>
                  <ChevronDown
                    className={`h-3.5 w-3.5 transition-transform ${
                      languageDropdownOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>

                {languageDropdownOpen && (
                  <div className="absolute top-full right-0 z-50 mt-2 w-56 overflow-hidden rounded-2xl border border-white/10 bg-[rgba(8,14,24,0.96)] shadow-[0_18px_40px_rgba(2,6,23,0.45)] backdrop-blur-xl">
                    <div className="border-b border-white/7 p-2">
                      <input
                        ref={languageSearchInputRef}
                        type="text"
                        value={languageSearch}
                        onChange={(e) => setLanguageSearch(e.target.value)}
                        onKeyDown={(e) => {
                          if (
                            e.key === "Enter" &&
                            filteredLanguages.length > 0
                          ) {
                            setLanguageFilter(filteredLanguages[0].value);
                            setLanguageDropdownOpen(false);
                            setLanguageSearch("");
                          } else if (e.key === "Escape") {
                            setLanguageDropdownOpen(false);
                            setLanguageSearch("");
                          }
                        }}
                        placeholder={t(
                          "settings.general.language.searchPlaceholder",
                        )}
                        className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-text/88 outline-none transition focus:border-logo-primary/35 focus:ring-1 focus:ring-logo-primary/30"
                      />
                    </div>
                    <div className="max-h-48 overflow-y-auto">
                      <button
                        type="button"
                        onClick={() => {
                          setLanguageFilter("all");
                          setLanguageDropdownOpen(false);
                          setLanguageSearch("");
                        }}
                        className={`w-full px-3 py-2 text-left text-sm transition-colors ${
                          languageFilter === "all"
                            ? "bg-logo-primary/10 font-semibold text-text"
                            : "hover:bg-white/[0.05]"
                        }`}
                      >
                        {t("settings.models.filters.allLanguages")}
                      </button>
                      {filteredLanguages.map((lang) => (
                        <button
                          key={lang.value}
                          type="button"
                          onClick={() => {
                            setLanguageFilter(lang.value);
                            setLanguageDropdownOpen(false);
                            setLanguageSearch("");
                          }}
                          className={`w-full px-3 py-2 text-left text-sm transition-colors ${
                            languageFilter === lang.value
                              ? "bg-logo-primary/10 font-semibold text-text"
                              : "hover:bg-white/[0.05]"
                          }`}
                        >
                          {lang.label}
                        </button>
                      ))}
                      {filteredLanguages.length === 0 && (
                        <div className="px-3 py-3 text-center text-sm text-text/46">
                          {t("settings.general.language.noResults")}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
            {downloadedModels.map((model: ModelInfo) => (
              <ModelCard
                key={model.id}
                model={model}
                status={getModelStatus(model.id)}
                onSelect={handleModelSelect}
                onDownload={handleModelDownload}
                onDelete={handleModelDelete}
                onCancel={handleModelCancel}
                downloadProgress={getDownloadProgress(model.id)}
                downloadSpeed={getDownloadSpeed(model.id)}
                showRecommended={false}
              />
            ))}
          </div>

          {cloudModels.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-text/34">
                  {t("settings.models.groq.cloudModelsTitle", {
                    defaultValue: "Cloud Models",
                  })}
                </h2>
                {!hasGroqApiKey && (
                  <div className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5 text-xs text-text/50">
                    {t("settings.models.groq.enableHint", {
                      defaultValue:
                        "Add a Groq API key in API Keys to enable selection.",
                    })}
                  </div>
                )}
              </div>
              {cloudModels.map((model: ModelInfo) => (
                <ModelCard
                  key={model.id}
                  model={model}
                  status={getModelStatus(model.id)}
                  disabled={!hasGroqApiKey || isGroqApiKeyUpdating}
                  onSelect={handleModelSelect}
                  onDownload={handleModelDownload}
                  onDelete={handleModelDelete}
                  onCancel={handleModelCancel}
                  downloadProgress={getDownloadProgress(model.id)}
                  downloadSpeed={getDownloadSpeed(model.id)}
                  showRecommended={false}
                />
              ))}
            </div>
          )}

          {availableModels.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-text/34">
                {t("settings.models.availableModels")}
              </h2>
              {availableModels.map((model: ModelInfo) => (
                <ModelCard
                  key={model.id}
                  model={model}
                  status={getModelStatus(model.id)}
                  onSelect={handleModelSelect}
                  onDownload={handleModelDownload}
                  onDelete={handleModelDelete}
                  onCancel={handleModelCancel}
                  downloadProgress={getDownloadProgress(model.id)}
                  downloadSpeed={getDownloadSpeed(model.id)}
                  showRecommended={false}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-[18px] border border-white/7 bg-white/[0.02] px-4 py-8 text-center text-text/46">
          {t("settings.models.noModelsMatch")}
        </div>
      )}
    </div>
  );
};

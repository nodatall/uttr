import React from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  Cloud,
  Download,
  Globe,
  Languages,
  Loader2,
  Trash2,
} from "lucide-react";
import type { ModelInfo } from "@/bindings";
import { formatModelSize } from "../../lib/utils/format";
import {
  getTranslatedModelDescription,
  getTranslatedModelName,
} from "../../lib/utils/modelTranslation";
import { LANGUAGES } from "../../lib/constants/languages";
import Badge from "../ui/Badge";
import { Button } from "../ui/Button";

// Get display text for model's language support
const getLanguageDisplayText = (
  supportedLanguages: string[],
  t: (key: string, options?: Record<string, unknown>) => string,
): string => {
  if (supportedLanguages.length === 1) {
    const langCode = supportedLanguages[0];
    const langName =
      LANGUAGES.find((l) => l.value === langCode)?.label || langCode;
    return t("modelSelector.capabilities.languageOnly", { language: langName });
  }
  return t("modelSelector.capabilities.multiLanguage");
};

const isCloudModel = (model: ModelInfo): boolean =>
  model.id.startsWith("groq-");

export type ModelCardStatus =
  | "downloadable"
  | "downloading"
  | "extracting"
  | "switching"
  | "active"
  | "available";

interface ModelCardProps {
  model: ModelInfo;
  variant?: "default" | "featured";
  status?: ModelCardStatus;
  disabled?: boolean;
  className?: string;
  onSelect: (modelId: string) => void;
  onDownload?: (modelId: string) => void;
  onDelete?: (modelId: string) => void;
  onCancel?: (modelId: string) => void;
  downloadProgress?: number;
  downloadSpeed?: number; // MB/s
  showRecommended?: boolean;
}

const ModelCard: React.FC<ModelCardProps> = ({
  model,
  variant = "default",
  status = "downloadable",
  disabled = false,
  className = "",
  onSelect,
  onDownload,
  onDelete,
  onCancel,
  downloadProgress,
  downloadSpeed,
  showRecommended = true,
}) => {
  const { t } = useTranslation();
  const isFeatured = variant === "featured";
  const isClickable =
    status === "available" || status === "active" || status === "downloadable";

  // Get translated model name and description
  const displayName = getTranslatedModelName(model, t);
  const displayDescription = getTranslatedModelDescription(model, t);

  const traitLabels = [
    model.speed_score >= 0.78
      ? t("settings.models.traits.lowLatency", { defaultValue: "Low latency" })
      : null,
    model.accuracy_score >= 0.82
      ? t("settings.models.traits.highAccuracy", {
          defaultValue: "High accuracy",
        })
      : null,
  ].filter(Boolean) as string[];

  if (
    traitLabels.length === 0 &&
    (model.speed_score > 0 || model.accuracy_score > 0)
  ) {
    traitLabels.push(
      t("settings.models.traits.balanced", { defaultValue: "Balanced" }),
    );
  }

  const baseClasses =
    "flex flex-col gap-3 rounded-[18px] border px-4 py-4 text-left transition-all duration-200";

  const getVariantClasses = () => {
    if (status === "active") {
      return "border-logo-primary/34 bg-[linear-gradient(180deg,rgba(103,215,163,0.11),rgba(103,215,163,0.04))] shadow-[0_12px_28px_rgba(16,185,129,0.08)]";
    }
    if (isFeatured) {
      return "border-logo-primary/20 bg-logo-primary/4";
    }
    return "border-white/7 bg-white/[0.025]";
  };

  const getInteractiveClasses = () => {
    if (!isClickable) return "";
    if (disabled) return "opacity-50 cursor-not-allowed";
    return "group cursor-pointer hover:-translate-y-0.5 hover:border-white/14 hover:bg-white/[0.045] hover:shadow-[0_14px_32px_rgba(2,6,23,0.24)] active:translate-y-0";
  };

  const handleClick = () => {
    if (!isClickable || disabled) return;
    if (!isCloudModel(model) && status === "downloadable" && onDownload) {
      onDownload(model.id);
    } else {
      onSelect(model.id);
    }
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete?.(model.id);
  };

  return (
    <div
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" && isClickable) handleClick();
      }}
      role={isClickable ? "button" : undefined}
      tabIndex={isClickable ? 0 : undefined}
      className={[
        baseClasses,
        getVariantClasses(),
        getInteractiveClasses(),
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex w-full items-start justify-between gap-4">
        <div className="flex flex-col items-start flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h3
              className={`text-[17px] font-semibold tracking-tight text-text ${isClickable ? "group-hover:text-white" : ""} transition-colors`}
            >
              {displayName}
            </h3>
            {showRecommended && model.is_recommended && (
              <Badge variant="primary">{t("onboarding.recommended")}</Badge>
            )}
            {status === "active" && (
              <Badge variant="primary">
                <Check className="w-3 h-3 mr-1" />
                {t("modelSelector.active")}
              </Badge>
            )}
            {model.is_custom && (
              <Badge variant="secondary">{t("modelSelector.custom")}</Badge>
            )}
            {isCloudModel(model) && (
              <Badge variant="secondary">
                <Cloud className="w-3 h-3 mr-1" />
                {t("settings.models.groq.badge", { defaultValue: "Cloud" })}
              </Badge>
            )}
            {status === "switching" && (
              <Badge variant="secondary">
                <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                {t("modelSelector.switching")}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm leading-relaxed text-text/56">
            {displayDescription}
          </p>
        </div>
        {traitLabels.length > 0 && (
          <div className="hidden shrink-0 gap-2 sm:flex">
            {traitLabels.map((label) => (
              <span
                key={label}
                className="rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-text/56"
              >
                {label}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="h-px w-full bg-white/7" />

      <div className="flex min-h-5 w-full flex-wrap items-center gap-3 text-xs text-text/48">
        {model.supported_languages.length > 0 && (
          <div
            className="flex items-center gap-1"
            title={
              model.supported_languages.length === 1
                ? t("modelSelector.capabilities.singleLanguage")
                : t("modelSelector.capabilities.languageSelection")
            }
          >
            <Globe className="w-3.5 h-3.5" />
            <span>{getLanguageDisplayText(model.supported_languages, t)}</span>
          </div>
        )}
        {model.supports_translation && (
          <div
            className="flex items-center gap-1"
            title={t("modelSelector.capabilities.translation")}
          >
            <Languages className="w-3.5 h-3.5" />
            <span>{t("modelSelector.capabilities.translate")}</span>
          </div>
        )}
        {status === "downloadable" && !isCloudModel(model) && (
          <span className="ml-auto flex items-center gap-1.5">
            <Download className="w-3.5 h-3.5" />
            <span>{formatModelSize(Number(model.size_mb))}</span>
          </span>
        )}
        {onDelete &&
          !isCloudModel(model) &&
          (status === "available" || status === "active") && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDelete}
              title={t("modelSelector.deleteModel", { modelName: displayName })}
              className="ml-auto flex items-center gap-1.5 text-text/56 hover:text-text"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{t("common.delete")}</span>
            </Button>
          )}
      </div>

      {/* Download/extract progress */}
      {status === "downloading" && downloadProgress !== undefined && (
        <div className="w-full mt-3">
          <div className="w-full h-1.5 bg-mid-gray/20 rounded-full overflow-hidden">
            <div
              className="h-full bg-logo-primary rounded-full transition-all duration-300"
              style={{ width: `${downloadProgress}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-xs mt-1">
            <span className="text-text/50">
              {t("modelSelector.downloading", {
                percentage: Math.round(downloadProgress),
              })}
            </span>
            <div className="flex items-center gap-2">
              {downloadSpeed !== undefined && downloadSpeed > 0 && (
                <span className="tabular-nums text-text/50">
                  {t("modelSelector.downloadSpeed", {
                    speed: downloadSpeed.toFixed(1),
                  })}
                </span>
              )}
              {onCancel && (
                <Button
                  variant="danger-ghost"
                  size="sm"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onCancel(model.id);
                  }}
                  aria-label={t("modelSelector.cancelDownload")}
                >
                  {t("modelSelector.cancel")}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
      {status === "extracting" && (
        <div className="w-full mt-3">
          <div className="w-full h-1.5 bg-mid-gray/20 rounded-full overflow-hidden">
            <div className="h-full bg-logo-primary rounded-full animate-pulse w-full" />
          </div>
          <p className="text-xs text-text/50 mt-1">
            {t("modelSelector.extractingGeneric")}
          </p>
        </div>
      )}
    </div>
  );
};

export default ModelCard;

import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AudioLines,
  Ban,
  CheckCircle2,
  Copy,
  FileAudio,
  LoaderCircle,
  Play,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { commands, type SavedFileTranscription } from "@/bindings";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Textarea";
import { useSettings } from "@/hooks/useSettings";

const SUPPORTED_EXTENSIONS = ["wav", "mp3", "m4a", "aac", "ogg"] as const;

interface FileTranscriptionProgressEvent {
  percentage: number;
  stage: string;
  current_chunk?: number | null;
  total_chunks?: number | null;
}

const extensionFromPath = (path: string) => {
  const parts = path.split(".");
  if (parts.length < 2) return "";
  return parts[parts.length - 1]?.toLowerCase() ?? "";
};

const fileNameFromPath = (path: string) => {
  const segments = path.split(/[/\\]/);
  return segments[segments.length - 1] || path;
};

export const FileTranscriptionSettings: React.FC = () => {
  const { t } = useTranslation();
  const { settings, refreshSettings } = useSettings();
  const [isDragActive, setIsDragActive] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [progress, setProgress] =
    useState<FileTranscriptionProgressEvent | null>(null);

  const history = settings?.file_transcription_history ?? [];
  const supportedFormatsText = SUPPORTED_EXTENSIONS.join(", ");

  const selectPath = useCallback(
    (path: string) => {
      setSelectedFilePath(path);
      setSelectedFileName(fileNameFromPath(path));
      setErrorMessage(null);
      setProgress(null);
      setInfoMessage(
        t("settings.fileTranscription.readyState", {
          defaultValue:
            "File selected. Review it, then click Transcribe when you're ready.",
        }),
      );
    },
    [t],
  );

  const handlePaths = useCallback(
    async (paths: string[]) => {
      if (isProcessing) {
        toast.error(
          t("settings.fileTranscription.errors.inProgress", {
            defaultValue: "Wait for the current file to finish transcribing.",
          }),
        );
        return;
      }

      if (paths.length !== 1) {
        const message = t("settings.fileTranscription.errors.singleFile", {
          defaultValue: "Drop or choose exactly one audio file.",
        });
        setErrorMessage(message);
        toast.error(message);
        return;
      }

      const path = paths[0];
      const extension = extensionFromPath(path);
      if (
        !SUPPORTED_EXTENSIONS.includes(
          extension as (typeof SUPPORTED_EXTENSIONS)[number],
        )
      ) {
        const message = t(
          "settings.fileTranscription.errors.unsupportedFormat",
          {
            defaultValue: "Unsupported audio format. Use {{formats}}.",
            formats: supportedFormatsText,
          },
        );
        setErrorMessage(message);
        toast.error(message);
        return;
      }

      selectPath(path);
    },
    [isProcessing, selectPath, supportedFormatsText, t],
  );

  const chooseAudioFile = useCallback(async () => {
    if (isProcessing) return;

    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        {
          name: t("settings.fileTranscription.fileFilter", {
            defaultValue: "Audio Files",
          }),
          extensions: [...SUPPORTED_EXTENSIONS],
        },
      ],
    });

    if (typeof selected === "string") {
      await handlePaths([selected]);
    }
  }, [handlePaths, isProcessing, t]);

  const clearResult = useCallback(() => {
    setIsDragActive(false);
    setIsProcessing(false);
    setSelectedFilePath(null);
    setSelectedFileName(null);
    setErrorMessage(null);
    setInfoMessage(null);
    setProgress(null);
  }, []);

  const startTranscription = useCallback(async () => {
    if (!selectedFilePath || isProcessing) return;

    setIsProcessing(true);
    setErrorMessage(null);
    setInfoMessage(null);
    setProgress({
      percentage: 0,
      stage: t("settings.fileTranscription.starting", {
        defaultValue: "Starting transcription...",
      }),
    });

    try {
      const response = await commands.transcribeAudioFile(selectedFilePath);
      if (response.status === "ok") {
        setSelectedFilePath(null);
        setSelectedFileName(null);
        setProgress(null);
        setInfoMessage(
          t("settings.fileTranscription.completed", {
            defaultValue: "Transcription finished.",
          }),
        );
        await refreshSettings();
        return;
      }

      const message = String(response.error);
      if (message.toLowerCase().includes("cancelled")) {
        setInfoMessage(
          t("settings.fileTranscription.cancelled", {
            defaultValue: "Transcription cancelled.",
          }),
        );
        setProgress(null);
        return;
      }

      setErrorMessage(message);
    } catch (error) {
      const message = String(error);
      if (message.toLowerCase().includes("cancelled")) {
        setInfoMessage(
          t("settings.fileTranscription.cancelled", {
            defaultValue: "Transcription cancelled.",
          }),
        );
        setProgress(null);
        return;
      }

      setErrorMessage(message);
    } finally {
      setIsProcessing(false);
    }
  }, [isProcessing, refreshSettings, selectedFilePath, t]);

  const cancelTranscription = useCallback(async () => {
    if (!isProcessing) return;

    const cancellingMessage = t("settings.fileTranscription.cancelling", {
      defaultValue: "Cancelling transcription...",
    });
    setInfoMessage(cancellingMessage);
    setProgress((current) => ({
      percentage: current?.percentage ?? 0,
      stage: cancellingMessage,
      current_chunk: current?.current_chunk,
      total_chunks: current?.total_chunks,
    }));

    try {
      await commands.cancelOperation();
    } catch (error) {
      setErrorMessage(String(error));
    }
  }, [isProcessing, t]);

  const copyTranscript = useCallback(
    async (transcriptText: string) => {
      if (!transcriptText) return;
      try {
        await navigator.clipboard.writeText(transcriptText);
        toast.success(
          t("settings.fileTranscription.copySuccess", {
            defaultValue: "Transcript copied to clipboard.",
          }),
        );
      } catch (error) {
        toast.error(String(error));
      }
    },
    [t],
  );

  const clearPersistedResult = useCallback(async () => {
    clearResult();
    await commands.clearFileTranscriptionHistory();
    await refreshSettings();
  }, [clearResult, refreshSettings]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (event.payload.type === "leave") {
          setIsDragActive(false);
          return;
        }

        if (event.payload.type === "enter" || event.payload.type === "over") {
          setIsDragActive(!isProcessing);
          return;
        }

        setIsDragActive(false);
        if (event.payload.type === "drop") {
          await handlePaths(event.payload.paths);
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((error) => {
        console.error("Failed to listen for drag-drop events:", error);
      });

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [handlePaths, isProcessing]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen<FileTranscriptionProgressEvent>(
      "file-transcription-progress",
      (event) => {
        setProgress(event.payload);
      },
    )
      .then((fn) => {
        unlisten = fn;
      })
      .catch((error) => {
        console.error(
          "Failed to listen for file transcription progress:",
          error,
        );
      });

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-text/34">
            {t("settings.fileTranscription.eyebrow", {
              defaultValue: "Utility",
            })}
          </p>
          <h1 className="text-[28px] font-semibold tracking-tight text-text">
            {t("settings.fileTranscription.title", {
              defaultValue: "File Transcription",
            })}
          </h1>
          <p className="max-w-2xl text-sm text-text/50">
            {t("settings.fileTranscription.description", {
              defaultValue:
                "Drop in one audio file or choose one from disk. Uttr will transcribe it using your current language and post-processing settings.",
            })}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void clearPersistedResult();
            }}
            disabled={
              isProcessing ||
              (!selectedFilePath &&
                !selectedFileName &&
                !errorMessage &&
                !infoMessage &&
                history.length === 0)
            }
            className="flex items-center gap-2 rounded-full"
          >
            <Trash2 className="h-4 w-4" />
            <span>
              {t("settings.fileTranscription.clear", {
                defaultValue: "Clear",
              })}
            </span>
          </Button>
          <Button
            type="button"
            variant="primary-soft"
            onClick={() => {
              void chooseAudioFile();
            }}
            disabled={isProcessing}
            className="flex items-center gap-2 rounded-full"
          >
            <Upload className="h-4 w-4" />
            <span>
              {t("settings.fileTranscription.chooseFile", {
                defaultValue: "Choose Audio File",
              })}
            </span>
          </Button>
          {isProcessing ? (
            <Button
              type="button"
              variant="danger-ghost"
              onClick={() => {
                void cancelTranscription();
              }}
              className="flex items-center gap-2 rounded-full"
            >
              <Ban className="h-4 w-4" />
              <span>
                {t("settings.fileTranscription.cancel", {
                  defaultValue: "Cancel",
                })}
              </span>
            </Button>
          ) : (
            <Button
              type="button"
              variant="primary"
              onClick={() => {
                void startTranscription();
              }}
              disabled={!selectedFilePath}
              className="flex items-center gap-2 rounded-full"
            >
              <Play className="h-4 w-4" />
              <span>
                {t("settings.fileTranscription.transcribe", {
                  defaultValue: "Transcribe",
                })}
              </span>
            </Button>
          )}
        </div>
      </div>

      <div
        className={`rounded-[22px] border px-6 py-7 transition-all ${
          isDragActive
            ? "border-logo-primary/60 bg-logo-primary/10 shadow-[0_0_0_1px_rgba(103,215,163,0.2)]"
            : "border-white/8 bg-white/[0.02]"
        }`}
      >
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="rounded-full border border-white/10 bg-white/[0.03] p-4">
            {isProcessing ? (
              <LoaderCircle className="h-7 w-7 animate-spin text-logo-primary" />
            ) : isDragActive ? (
              <CheckCircle2 className="h-7 w-7 text-logo-primary" />
            ) : (
              <FileAudio className="h-7 w-7 text-text/70" />
            )}
          </div>
          <div className="space-y-1">
            <p className="text-base font-medium text-text">
              {isProcessing
                ? progress?.stage ||
                  t("settings.fileTranscription.processing", {
                    defaultValue: "Transcribing audio file...",
                  })
                : selectedFileName
                  ? t("settings.fileTranscription.readyTitle", {
                      defaultValue: "File selected and ready to transcribe",
                    })
                  : t("settings.fileTranscription.dropzoneTitle", {
                      defaultValue: "Drag and drop one audio file here",
                    })}
            </p>
            <p className="text-sm text-text/50">
              {selectedFileName && !isProcessing
                ? t("settings.fileTranscription.manualStartHint", {
                    defaultValue:
                      "Selecting a file does not start transcription. Click Transcribe when you want to begin.",
                  })
                : t("settings.fileTranscription.dropzoneDescription", {
                    defaultValue: "Supported formats: {{formats}}",
                    formats: supportedFormatsText,
                  })}
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void chooseAudioFile();
            }}
            disabled={isProcessing}
            className="flex items-center gap-2 rounded-full"
          >
            <AudioLines className="h-4 w-4" />
            <span>
              {t("settings.fileTranscription.browse", {
                defaultValue: "Browse for file",
              })}
            </span>
          </Button>
        </div>
      </div>

      {isProcessing && progress && (
        <div className="rounded-[18px] border border-white/7 bg-white/[0.02] p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-text">{progress.stage}</p>
              <p className="mt-1 text-xs text-text/45">
                {progress.current_chunk && progress.total_chunks
                  ? t("settings.fileTranscription.progressChunks", {
                      defaultValue: "Chunk {{current}} of {{total}}",
                      current: progress.current_chunk,
                      total: progress.total_chunks,
                    })
                  : t("settings.fileTranscription.progressPreparing", {
                      defaultValue: "Preparing transcription",
                    })}
              </p>
            </div>
            <p className="text-sm font-medium tabular-nums text-logo-primary">
              {Math.max(0, Math.min(100, progress.percentage))}%
            </p>
          </div>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-white/8">
            <div
              className="h-full rounded-full bg-logo-primary transition-all duration-300"
              style={{
                width: `${Math.max(0, Math.min(100, progress.percentage))}%`,
              }}
            />
          </div>
        </div>
      )}

      {selectedFileName && (
        <div className="rounded-[18px] border border-white/7 bg-white/[0.02] px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.16em] text-text/35">
                {t("settings.fileTranscription.currentFileLabel", {
                  defaultValue: "Current file",
                })}
              </p>
              <p className="mt-1 text-sm font-medium text-text">
                {selectedFileName}
              </p>
            </div>
            {isProcessing ? (
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-text/70">
                {t("settings.fileTranscription.inProgressBadge", {
                  defaultValue: "In progress",
                })}
              </span>
            ) : selectedFilePath ? (
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-text/70">
                {t("settings.fileTranscription.readyBadge", {
                  defaultValue: "Ready",
                })}
              </span>
            ) : null}
          </div>
        </div>
      )}

      {infoMessage && !errorMessage && (
        <Alert variant="info">{infoMessage}</Alert>
      )}

      {errorMessage && <Alert variant="error">{errorMessage}</Alert>}

      {!infoMessage &&
        !errorMessage &&
        !isProcessing &&
        selectedFilePath && (
          <Alert variant="info">
            {t("settings.fileTranscription.readyState", {
              defaultValue:
                "File selected. Review it, then click Transcribe when you're ready.",
            })}
          </Alert>
        )}

      {!errorMessage &&
        !isProcessing &&
        !selectedFilePath &&
        history.length === 0 && (
          <Alert variant="info">
            {t("settings.fileTranscription.emptyState", {
              defaultValue:
                "Uttr keeps your five most recent file transcriptions here. They are not added to transcription history.",
            })}
          </Alert>
        )}

      {history.length > 0 && (
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-[0.16em] text-text/35">
              {t("settings.fileTranscription.historyLabel", {
                defaultValue: "Recent file transcriptions",
              })}
            </p>
            <p className="text-sm text-text/55">
              {t("settings.fileTranscription.historyDescription", {
                defaultValue:
                  "Uttr keeps the five most recent file transcriptions from this screen.",
              })}
            </p>
          </div>

          {history.map((entry: SavedFileTranscription, index: number) => {
            const transcriptText =
              entry.post_processed_text || entry.transcription_text;

            return (
              <div
                key={`${entry.source_path ?? entry.file_name}-${index}`}
                className="rounded-[18px] border border-white/7 bg-white/[0.02] p-4"
              >
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-text/35">
                      {t("settings.fileTranscription.fileNameLabel", {
                        defaultValue: "File",
                      })}
                    </p>
                    <p className="mt-1 text-sm font-medium text-text">
                      {entry.file_name}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {index === 0 && (
                      <span className="rounded-full border border-logo-primary/20 bg-logo-primary/10 px-3 py-1 text-xs font-medium text-logo-primary">
                        {t("settings.fileTranscription.latestBadge", {
                          defaultValue: "Latest",
                        })}
                      </span>
                    )}
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        void copyTranscript(transcriptText);
                      }}
                      className="flex items-center gap-2 rounded-full"
                    >
                      <Copy className="h-4 w-4" />
                      <span>
                        {t("settings.fileTranscription.copy", {
                          defaultValue: "Copy",
                        })}
                      </span>
                    </Button>
                  </div>
                </div>
                <Textarea
                  value={transcriptText}
                  readOnly
                  className="min-h-[180px] w-full resize-y"
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

import React, { useCallback, useEffect, useReducer } from "react";
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
import {
  isPremiumFeatureLocked,
  PREMIUM_FEATURE_LOCK_MESSAGE,
} from "@/lib/utils/premiumFeatures";

const SUPPORTED_EXTENSIONS = ["wav", "mp3", "m4a", "aac", "ogg"] as const;

interface FileTranscriptionProgressEvent {
  percentage: number;
  stage: string;
  current_chunk?: number | null;
  total_chunks?: number | null;
}

interface FileTranscriptionState {
  isDragActive: boolean;
  isProcessing: boolean;
  selectedFilePath: string | null;
  selectedFileName: string | null;
  errorMessage: string | null;
  infoMessage: string | null;
  progress: FileTranscriptionProgressEvent | null;
}

type FileTranscriptionAction =
  | { type: "drag_active"; active: boolean }
  | { type: "select_path"; path: string; readyMessage: string }
  | { type: "error"; message: string }
  | { type: "clear" }
  | { type: "transcription_started"; progress: FileTranscriptionProgressEvent }
  | { type: "transcription_completed"; message: string }
  | { type: "transcription_cancelled"; message: string }
  | { type: "transcription_finished" }
  | { type: "cancelling"; message: string }
  | { type: "progress"; progress: FileTranscriptionProgressEvent };

const fileTranscriptionInitialState: FileTranscriptionState = {
  isDragActive: false,
  isProcessing: false,
  selectedFilePath: null,
  selectedFileName: null,
  errorMessage: null,
  infoMessage: null,
  progress: null,
};

const fileTranscriptionReducer = (
  state: FileTranscriptionState,
  action: FileTranscriptionAction,
): FileTranscriptionState => {
  switch (action.type) {
    case "drag_active":
      return { ...state, isDragActive: action.active };
    case "select_path":
      return {
        ...state,
        selectedFilePath: action.path,
        selectedFileName: fileNameFromPath(action.path),
        errorMessage: null,
        infoMessage: action.readyMessage,
        progress: null,
      };
    case "error":
      return { ...state, errorMessage: action.message };
    case "clear":
      return fileTranscriptionInitialState;
    case "transcription_started":
      return {
        ...state,
        isProcessing: true,
        errorMessage: null,
        infoMessage: null,
        progress: action.progress,
      };
    case "transcription_completed":
      return {
        ...state,
        selectedFilePath: null,
        selectedFileName: null,
        progress: null,
        infoMessage: action.message,
      };
    case "transcription_cancelled":
      return {
        ...state,
        progress: null,
        infoMessage: action.message,
      };
    case "transcription_finished":
      return { ...state, isProcessing: false };
    case "cancelling":
      return {
        ...state,
        infoMessage: action.message,
        progress: {
          percentage: state.progress?.percentage ?? 0,
          stage: action.message,
          current_chunk: state.progress?.current_chunk,
          total_chunks: state.progress?.total_chunks,
        },
      };
    case "progress":
      return { ...state, progress: action.progress };
  }
};

const extensionFromPath = (path: string) => {
  const parts = path.split(".");
  if (parts.length < 2) return "";
  return parts[parts.length - 1]?.toLowerCase() ?? "";
};

const fileNameFromPath = (path: string) => {
  const segments = path.split(/[/\\]/);
  return segments[segments.length - 1] || path;
};

const useFileTranscriptionController = () => {
  const { t } = useTranslation();
  const { installAccess, refreshInstallAccess, settings, refreshSettings } =
    useSettings();
  const [
    {
      isDragActive,
      isProcessing,
      selectedFilePath,
      selectedFileName,
      errorMessage,
      infoMessage,
      progress,
    },
    dispatch,
  ] = useReducer(fileTranscriptionReducer, fileTranscriptionInitialState);

  const history = settings?.file_transcription_history ?? [];
  const supportedFormatsText = SUPPORTED_EXTENSIONS.join(", ");
  const accessLoaded = installAccess !== null;
  const premiumLocked = isPremiumFeatureLocked(installAccess);
  const lockedMessage = t("settings.fileTranscription.locked", {
    defaultValue: PREMIUM_FEATURE_LOCK_MESSAGE,
  });

  useEffect(() => {
    void refreshInstallAccess();
  }, [refreshInstallAccess]);

  const selectPath = useCallback(
    (path: string) => {
      dispatch({
        type: "select_path",
        path,
        readyMessage: t("settings.fileTranscription.readyState", {
          defaultValue:
            "File selected. Review it, then click Transcribe when you're ready.",
        }),
      });
    },
    [t],
  );

  const handlePaths = useCallback(
    async (paths: string[]) => {
      if (premiumLocked) {
        dispatch({ type: "error", message: lockedMessage });
        toast.error(lockedMessage);
        return;
      }

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
        dispatch({ type: "error", message });
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
        dispatch({ type: "error", message });
        toast.error(message);
        return;
      }

      selectPath(path);
    },
    [
      isProcessing,
      lockedMessage,
      premiumLocked,
      selectPath,
      supportedFormatsText,
      t,
    ],
  );

  const chooseAudioFile = useCallback(async () => {
    if (isProcessing || premiumLocked) {
      if (premiumLocked) {
        dispatch({ type: "error", message: lockedMessage });
        toast.error(lockedMessage);
      }
      return;
    }

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
  }, [handlePaths, isProcessing, lockedMessage, premiumLocked, t]);

  const clearResult = useCallback(() => {
    dispatch({ type: "clear" });
  }, []);

  const startTranscription = useCallback(async () => {
    if (premiumLocked) {
      dispatch({ type: "error", message: lockedMessage });
      return;
    }

    if (!selectedFilePath || isProcessing) return;

    dispatch({
      type: "transcription_started",
      progress: {
        percentage: 0,
        stage: t("settings.fileTranscription.starting", {
          defaultValue: "Starting transcription...",
        }),
      },
    });

    try {
      const response = await commands.transcribeAudioFile(selectedFilePath);
      if (response.status === "ok") {
        dispatch({
          type: "transcription_completed",
          message: t("settings.fileTranscription.completed", {
            defaultValue: "Transcription finished.",
          }),
        });
        await refreshSettings();
        return;
      }

      const message = String(response.error);
      if (message.toLowerCase().includes("cancelled")) {
        dispatch({
          type: "transcription_cancelled",
          message: t("settings.fileTranscription.cancelled", {
            defaultValue: "Transcription cancelled.",
          }),
        });
        return;
      }

      dispatch({ type: "error", message });
    } catch (error) {
      const message = String(error);
      if (message.toLowerCase().includes("cancelled")) {
        dispatch({
          type: "transcription_cancelled",
          message: t("settings.fileTranscription.cancelled", {
            defaultValue: "Transcription cancelled.",
          }),
        });
        return;
      }

      dispatch({ type: "error", message });
    } finally {
      dispatch({ type: "transcription_finished" });
    }
  }, [
    isProcessing,
    lockedMessage,
    premiumLocked,
    refreshSettings,
    selectedFilePath,
    t,
  ]);

  const cancelTranscription = useCallback(async () => {
    if (!isProcessing) return;

    const cancellingMessage = t("settings.fileTranscription.cancelling", {
      defaultValue: "Cancelling transcription...",
    });
    dispatch({ type: "cancelling", message: cancellingMessage });

    try {
      await commands.cancelOperation();
    } catch (error) {
      dispatch({ type: "error", message: String(error) });
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
          dispatch({ type: "drag_active", active: false });
          return;
        }

        if (event.payload.type === "enter" || event.payload.type === "over") {
          dispatch({
            type: "drag_active",
            active: !isProcessing && !premiumLocked,
          });
          return;
        }

        dispatch({ type: "drag_active", active: false });
        if (event.payload.type === "drop" && !premiumLocked) {
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
  }, [handlePaths, isProcessing, premiumLocked]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen<FileTranscriptionProgressEvent>(
      "file-transcription-progress",
      (event) => {
        dispatch({ type: "progress", progress: event.payload });
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

  return {
    t,
    history,
    supportedFormatsText,
    accessLoaded,
    premiumLocked,
    lockedMessage,
    isDragActive,
    isProcessing,
    selectedFilePath,
    selectedFileName,
    errorMessage,
    infoMessage,
    progress,
    chooseAudioFile,
    clearPersistedResult,
    startTranscription,
    cancelTranscription,
    copyTranscript,
  };
};

interface FileTranscriptionHistoryListProps {
  history: SavedFileTranscription[];
  onCopyTranscript: (transcriptText: string) => void;
}

const FileTranscriptionHistoryList: React.FC<
  FileTranscriptionHistoryListProps
> = ({ history, onCopyTranscript }) => {
  const { t } = useTranslation();
  const latestEntry = history[0];
  const latestTranscriptText =
    latestEntry?.post_processed_text || latestEntry?.transcription_text;
  const latestEntryKey = latestEntry
    ? `${latestEntry.source_path ?? latestEntry.file_name}-${latestTranscriptText}`
    : null;

  if (history.length === 0) {
    return null;
  }

  return (
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

      {history.map((entry: SavedFileTranscription) => {
        const transcriptText =
          entry.post_processed_text || entry.transcription_text;
        const entryKey = `${entry.source_path ?? entry.file_name}-${transcriptText}`;

        return (
          <div
            key={entryKey}
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
                {entryKey === latestEntryKey && (
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
                    onCopyTranscript(transcriptText);
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
  );
};

export const FileTranscriptionSettings: React.FC = () => {
  const {
    t,
    history,
    supportedFormatsText,
    accessLoaded,
    premiumLocked,
    lockedMessage,
    isDragActive,
    isProcessing,
    selectedFilePath,
    selectedFileName,
    errorMessage,
    infoMessage,
    progress,
    chooseAudioFile,
    clearPersistedResult,
    startTranscription,
    cancelTranscription,
    copyTranscript,
  } = useFileTranscriptionController();

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-[28px] font-semibold tracking-tight text-text">
            {t("settings.fileTranscription.title", {
              defaultValue: "File Transcription",
            })}
          </h1>
          <p className="max-w-2xl text-sm text-text/50">
            {premiumLocked
              ? lockedMessage
              : t("settings.fileTranscription.description", {
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
            disabled={isProcessing || premiumLocked || !accessLoaded}
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
              disabled={!selectedFilePath || premiumLocked || !accessLoaded}
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

      {premiumLocked && (
        <Alert
          variant="info"
          className="rounded-[18px] border border-blue-400/15"
        >
          {lockedMessage}
        </Alert>
      )}

      <div
        className={`rounded-[22px] border px-6 py-7 transition-all ${
          isDragActive
            ? "border-logo-primary/60 bg-logo-primary/10 shadow-[0_0_0_1px_rgba(103,215,163,0.2)]"
            : "border-white/8 bg-white/[0.02]"
        } ${premiumLocked ? "pointer-events-none opacity-55 saturate-50" : ""}`}
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
                : premiumLocked
                  ? t("settings.fileTranscription.lockedTitle", {
                      defaultValue: "File transcription is locked on trial",
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
                : premiumLocked
                  ? lockedMessage
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
            disabled={isProcessing || premiumLocked || !accessLoaded}
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

      {!infoMessage && !errorMessage && !isProcessing && selectedFilePath && (
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

      <FileTranscriptionHistoryList
        history={history}
        onCopyTranscript={(transcriptText) => {
          void copyTranscript(transcriptText);
        }}
      />
    </div>
  );
};

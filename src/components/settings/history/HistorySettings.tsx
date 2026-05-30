import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { AudioPlayer } from "../../ui/AudioPlayer";
import { Button } from "../../ui/Button";
import { Copy, Star, Check, Trash2, FolderOpen } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readFile } from "@tauri-apps/plugin-fs";
import { commands, type HistoryEntry } from "@/bindings";
import { formatDateTime } from "@/utils/dateFormat";
import { useOsType } from "@/hooks/useOsType";
import { logFrontendStartup } from "@/lib/startupLog";

const MAX_VISIBLE_HISTORY = 20;
type HistoryTab = "dictations" | "sessions";
type HistoryMode = "dictations" | "meetings" | "all";

interface HistoryFocusRequest {
  entryId: number | null;
  token: number;
}

interface OpenRecordingsButtonProps {
  onClick: () => void;
  label: string;
}

const OpenRecordingsButton: React.FC<OpenRecordingsButtonProps> = ({
  onClick,
  label,
}) => (
  <Button
    onClick={onClick}
    variant="secondary"
    size="sm"
    className="flex items-center gap-2 rounded-full"
    title={label}
  >
    <FolderOpen className="w-4 h-4" />
    <span>{label}</span>
  </Button>
);

const formatHistoryPreviewText = (text: string): string => {
  const preview = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^#{1,6}\s+/.test(line))
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return preview || text.replace(/\s+/g, " ").trim();
};

interface HistorySettingsProps {
  focusRequest?: HistoryFocusRequest | null;
  onOpenSessionEntry?: (entry: HistoryEntry) => void;
  mode?: HistoryMode;
  compact?: boolean;
}

export const HistorySettings: React.FC<HistorySettingsProps> = ({
  focusRequest = null,
  onOpenSessionEntry,
  mode = "dictations",
  compact = false,
}) => {
  const { t } = useTranslation();
  const osType = useOsType();
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [highlightedEntryId, setHighlightedEntryId] = useState<number | null>(
    null,
  );
  const [activeTab, setActiveTab] = useState<HistoryTab>(
    mode === "meetings" ? "sessions" : "dictations",
  );
  const dictationEntries = historyEntries.filter(
    (entry) => entry.recording_source !== "full_system_audio",
  );
  const sessionEntries = historyEntries.filter(
    (entry) => entry.recording_source === "full_system_audio",
  );
  const showTabs = mode === "all";
  const activeEntries =
    mode === "meetings"
      ? sessionEntries
      : mode === "dictations"
        ? dictationEntries
        : activeTab === "sessions"
          ? sessionEntries
          : dictationEntries;
  const meetingsAreActive =
    mode === "meetings" || (mode === "all" && activeTab === "sessions");
  const visibleEntries = meetingsAreActive
    ? activeEntries
    : activeEntries.slice(0, MAX_VISIBLE_HISTORY);
  const focusedEntryId = focusRequest?.entryId ?? null;
  const focusedEntryVisible =
    focusedEntryId !== null &&
    historyEntries.some((entry) => entry.id === focusedEntryId);
  const containerClass = compact
    ? "w-full space-y-4"
    : "mx-auto w-full max-w-3xl space-y-5";
  const titleLabel =
    mode === "meetings"
      ? t("settings.history.meetingsTitle", {
          defaultValue: "Past meetings",
        })
      : t("settings.history.title", {
          defaultValue: "Transcriptions",
        });
  const emptyLabel =
    mode === "meetings"
      ? t("settings.history.emptySessions", {
          defaultValue: "No meetings yet.",
        })
      : t("settings.history.emptyDictations", {
          defaultValue: "No transcriptions yet.",
        });

  const loadHistoryEntries = useCallback(async () => {
    try {
      const result = await commands.getHistoryEntries();
      if (result.status === "ok") {
        setHistoryEntries(result.data);
      }
    } catch (error) {
      console.error("Failed to load history entries:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHistoryEntries();

    // Listen for history update events
    const setupListener = async () => {
      const unlisten = await listen("history-updated", () => {
        console.log("History updated, reloading entries...");
        loadHistoryEntries();
      });

      // Return cleanup function
      return unlisten;
    };

    let unlistenPromise = setupListener();

    return () => {
      unlistenPromise.then((unlisten) => {
        if (unlisten) {
          unlisten();
        }
      });
    };
  }, [loadHistoryEntries]);

  useEffect(() => {
    if (mode !== "all") {
      setActiveTab(mode === "meetings" ? "sessions" : "dictations");
    }
  }, [mode]);

  useEffect(() => {
    if (focusedEntryId === null || loading) {
      return;
    }

    const focusedEntry = historyEntries.find(
      (entry) => entry.id === focusedEntryId,
    );
    if (focusedEntry && mode === "all") {
      setActiveTab(
        focusedEntry.recording_source === "full_system_audio"
          ? "sessions"
          : "dictations",
      );
    }
  }, [focusedEntryId, historyEntries, loading, mode]);

  useEffect(() => {
    if (focusedEntryId === null || loading) {
      return;
    }

    const targetEntryId = focusedEntryId;
    const entryElement = document.querySelector<HTMLElement>(
      `[data-history-entry-id="${targetEntryId}"]`,
    );

    if (!entryElement) {
      return;
    }

    setHighlightedEntryId(targetEntryId);
    entryElement.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });

    const timeoutId = window.setTimeout(() => {
      setHighlightedEntryId((current) =>
        current === targetEntryId ? null : current,
      );
    }, 3200);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [focusedEntryId, loading, visibleEntries]);

  useEffect(() => {
    if (loading || focusedEntryId === null || !focusedEntryVisible) {
      return;
    }

    logFrontendStartup(`history settings visible id=${focusedEntryId}`);
  }, [focusedEntryId, focusedEntryVisible, loading]);

  const toggleSaved = async (id: number) => {
    try {
      await commands.toggleHistoryEntrySaved(id);
      // No need to reload here - the event listener will handle it
    } catch (error) {
      console.error("Failed to toggle saved status:", error);
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.error("Failed to copy to clipboard:", error);
    }
  };

  const getAudioUrl = useCallback(
    async (fileName: string) => {
      try {
        const result = await commands.getAudioFilePath(fileName);
        if (result.status === "ok") {
          if (osType === "linux") {
            const fileData = await readFile(result.data);
            const blob = new Blob([fileData], { type: "audio/wav" });

            return URL.createObjectURL(blob);
          }

          return convertFileSrc(result.data, "asset");
        }
        return null;
      } catch (error) {
        console.error("Failed to get audio file path:", error);
        return null;
      }
    },
    [osType],
  );

  const deleteAudioEntry = async (id: number) => {
    try {
      await commands.deleteHistoryEntry(id);
    } catch (error) {
      console.error("Failed to delete audio entry:", error);
      throw error;
    }
  };

  const openRecordingsFolder = async () => {
    try {
      await commands.openRecordingsFolder();
    } catch (error) {
      console.error("Failed to open recordings folder:", error);
    }
  };

  if (loading) {
    return (
      <div className={containerClass}>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-text/34">
                {titleLabel}
              </h2>
            </div>
            {!compact && (
              <OpenRecordingsButton
                onClick={openRecordingsFolder}
                label={t("settings.history.openFolder")}
              />
            )}
          </div>
          <div className="overflow-visible rounded-[18px] border border-white/7 bg-white/[0.02]">
            <div className="px-4 py-6 text-center text-text/50">
              {t("settings.history.loading")}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (historyEntries.length === 0) {
    return (
      <div className={containerClass}>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-text/34">
                {titleLabel}
              </h2>
            </div>
            {!compact && (
              <OpenRecordingsButton
                onClick={openRecordingsFolder}
                label={t("settings.history.openFolder")}
              />
            )}
          </div>
          <div className="overflow-visible rounded-[18px] border border-white/7 bg-white/[0.02]">
            <div className="px-4 py-6 text-center text-text/50">
              {emptyLabel}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={containerClass}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          {compact ? (
            <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-text/34">
              {titleLabel}
            </h2>
          ) : (
            <h1 className="text-[28px] font-semibold tracking-tight text-text">
              {titleLabel}
            </h1>
          )}
          {!compact && !meetingsAreActive && (
            <p className="text-sm text-text/50">
              {t("settings.history.showingLatest", {
                count: MAX_VISIBLE_HISTORY,
              })}
            </p>
          )}
        </div>
        {!compact && (
          <OpenRecordingsButton
            onClick={openRecordingsFolder}
            label={t("settings.history.openFolder")}
          />
        )}
      </div>
      {showTabs && (
        <div className="flex rounded-full border border-white/8 bg-white/[0.025] p-1 w-fit">
          <button
            type="button"
            onClick={() => setActiveTab("dictations")}
            className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
              activeTab === "dictations"
                ? "bg-logo-primary/14 text-logo-primary shadow-[inset_0_0_0_1px_rgba(103,215,163,0.18)]"
                : "text-text/58 hover:bg-white/[0.04] hover:text-text"
            }`}
          >
            {t("settings.history.dictations", { defaultValue: "Dictations" })}
            <span className="ml-2 text-xs text-text/42">
              {dictationEntries.length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("sessions")}
            className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
              activeTab === "sessions"
                ? "bg-logo-primary/14 text-logo-primary shadow-[inset_0_0_0_1px_rgba(103,215,163,0.18)]"
                : "text-text/58 hover:bg-white/[0.04] hover:text-text"
            }`}
          >
            {t("settings.history.sessions", { defaultValue: "Meetings" })}
            <span className="ml-2 text-xs text-text/42">
              {sessionEntries.length}
            </span>
          </button>
        </div>
      )}
      <div className="space-y-2">
        <div className="overflow-visible rounded-[18px] border border-white/7 bg-white/[0.02]">
          {visibleEntries.length === 0 ? (
            <div className="px-4 py-6 text-center text-text/50">
              {emptyLabel}
            </div>
          ) : (
            <div className="divide-y divide-white/6">
              {visibleEntries.map((entry) => (
                <HistoryEntryComponent
                  key={entry.id}
                  entry={entry}
                  highlighted={entry.id === highlightedEntryId}
                  onToggleSaved={() => toggleSaved(entry.id)}
                  onCopyText={(text) => copyToClipboard(text)}
                  onOpenSessionEntry={onOpenSessionEntry}
                  getAudioUrl={getAudioUrl}
                  deleteAudio={deleteAudioEntry}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

interface HistoryEntryProps {
  entry: HistoryEntry;
  highlighted: boolean;
  onToggleSaved: () => void;
  onCopyText: (text: string) => void;
  onOpenSessionEntry?: (entry: HistoryEntry) => void;
  getAudioUrl: (fileName: string) => Promise<string | null>;
  deleteAudio: (id: number) => Promise<void>;
}

const HistoryEntryComponent: React.FC<HistoryEntryProps> = ({
  entry,
  highlighted,
  onToggleSaved,
  onCopyText,
  onOpenSessionEntry,
  getAudioUrl,
  deleteAudio,
}) => {
  const { t, i18n } = useTranslation();
  const [showCopied, setShowCopied] = useState(false);
  const displayText = entry.post_processed_text || entry.transcription_text;
  const previewText = formatHistoryPreviewText(displayText);
  const isSession = entry.recording_source === "full_system_audio";

  const handleLoadAudio = useCallback(
    () => getAudioUrl(entry.file_name),
    [getAudioUrl, entry.file_name],
  );

  const handleCopyText = () => {
    onCopyText(displayText);
    setShowCopied(true);
    setTimeout(() => setShowCopied(false), 2000);
  };

  const handlePrimaryClick = () => {
    if (isSession && onOpenSessionEntry) {
      onOpenSessionEntry(entry);
      return;
    }

    handleCopyText();
  };

  const handleDeleteEntry = async () => {
    try {
      await deleteAudio(entry.id);
    } catch (error) {
      console.error("Failed to delete entry:", error);
      alert(t("settings.history.deleteError"));
    }
  };

  const formattedDate = formatDateTime(String(entry.timestamp), i18n.language);

  return (
    <div
      data-history-entry-id={entry.id}
      className={`group flex flex-col gap-3 px-4 py-4 transition-colors ${
        highlighted
          ? "bg-logo-primary/8 shadow-[inset_0_0_0_1px_rgba(103,215,163,0.18)]"
          : ""
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <p className="text-sm font-medium text-text/86">{formattedDate}</p>
          <button
            onClick={handlePrimaryClick}
            className={`w-full text-left text-[15px] leading-7 text-text/74 transition-colors hover:text-text ${
              isSession ? "cursor-pointer" : "cursor-copy"
            }`}
            title={
              isSession
                ? t("settings.history.openSession", {
                    defaultValue: "Open meeting",
                  })
                : t("settings.history.copyToClipboard")
            }
            style={{
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {previewText}
          </button>
        </div>
        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <button
            onClick={handleCopyText}
            className="rounded-lg p-2 text-text/42 transition-colors hover:bg-white/[0.04] hover:text-text"
            title={t("settings.history.copyToClipboard")}
          >
            {showCopied ? (
              <Check width={16} height={16} />
            ) : (
              <Copy width={16} height={16} />
            )}
          </button>
          <button
            onClick={onToggleSaved}
            className={`rounded-lg p-2 transition-colors cursor-pointer ${
              entry.saved
                ? "text-logo-primary hover:bg-logo-primary/10"
                : "text-text/42 hover:bg-white/[0.04] hover:text-text"
            }`}
            title={
              entry.saved
                ? t("settings.history.unsave")
                : t("settings.history.save")
            }
          >
            <Star
              width={16}
              height={16}
              fill={entry.saved ? "currentColor" : "none"}
            />
          </button>
          <button
            onClick={handleDeleteEntry}
            className="rounded-lg p-2 text-text/42 transition-colors cursor-pointer hover:bg-white/[0.04] hover:text-text"
            title={t("settings.history.delete")}
          >
            <Trash2 width={16} height={16} />
          </button>
        </div>
      </div>
      <AudioPlayer
        onLoadRequest={handleLoadAudio}
        className="w-full border-t border-white/6 pt-3"
      />
    </div>
  );
};

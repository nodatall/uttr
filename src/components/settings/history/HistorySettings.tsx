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

const MAX_VISIBLE_HISTORY = 20;

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

interface HistorySettingsProps {
  focusRequest?: HistoryFocusRequest | null;
}

export const HistorySettings: React.FC<HistorySettingsProps> = ({
  focusRequest = null,
}) => {
  const { t } = useTranslation();
  const osType = useOsType();
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [highlightedEntryId, setHighlightedEntryId] = useState<number | null>(
    null,
  );
  const visibleEntries = historyEntries.slice(0, MAX_VISIBLE_HISTORY);

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
    if (!focusRequest?.entryId || loading) {
      return;
    }

    const targetEntryId = focusRequest.entryId;
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
  }, [focusRequest, loading, visibleEntries]);

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
      <div className="mx-auto w-full max-w-3xl space-y-5">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-text/34">
                {t("settings.history.title")}
              </h2>
            </div>
            <OpenRecordingsButton
              onClick={openRecordingsFolder}
              label={t("settings.history.openFolder")}
            />
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
      <div className="mx-auto w-full max-w-3xl space-y-5">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-text/34">
                {t("settings.history.title")}
              </h2>
            </div>
            <OpenRecordingsButton
              onClick={openRecordingsFolder}
              label={t("settings.history.openFolder")}
            />
          </div>
          <div className="overflow-visible rounded-[18px] border border-white/7 bg-white/[0.02]">
            <div className="px-4 py-6 text-center text-text/50">
              {t("settings.history.empty")}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-text/34">
            {t("settings.history.eyebrow")}
          </p>
          <h1 className="text-[28px] font-semibold tracking-tight text-text">
            {t("settings.history.title")}
          </h1>
          <p className="text-sm text-text/50">
            {t("settings.history.showingLatest", {
              count: MAX_VISIBLE_HISTORY,
            })}
          </p>
        </div>
        <OpenRecordingsButton
          onClick={openRecordingsFolder}
          label={t("settings.history.openFolder")}
        />
      </div>
      <div className="space-y-2">
        <div className="overflow-visible rounded-[18px] border border-white/7 bg-white/[0.02]">
          <div className="divide-y divide-white/6">
            {visibleEntries.map((entry) => (
              <HistoryEntryComponent
                key={entry.id}
                entry={entry}
                highlighted={entry.id === highlightedEntryId}
                onToggleSaved={() => toggleSaved(entry.id)}
                onCopyText={(text) => copyToClipboard(text)}
                getAudioUrl={getAudioUrl}
                deleteAudio={deleteAudioEntry}
              />
            ))}
          </div>
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
  getAudioUrl: (fileName: string) => Promise<string | null>;
  deleteAudio: (id: number) => Promise<void>;
}

const HistoryEntryComponent: React.FC<HistoryEntryProps> = ({
  entry,
  highlighted,
  onToggleSaved,
  onCopyText,
  getAudioUrl,
  deleteAudio,
}) => {
  const { t, i18n } = useTranslation();
  const [showCopied, setShowCopied] = useState(false);
  const displayText = entry.post_processed_text || entry.transcription_text;

  const handleLoadAudio = useCallback(
    () => getAudioUrl(entry.file_name),
    [getAudioUrl, entry.file_name],
  );

  const handleCopyText = () => {
    onCopyText(displayText);
    setShowCopied(true);
    setTimeout(() => setShowCopied(false), 2000);
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
            onClick={handleCopyText}
            className="w-full cursor-copy text-left text-[15px] leading-7 text-text/74 transition-colors hover:text-text"
            title={t("settings.history.copyToClipboard")}
            style={{
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {displayText}
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

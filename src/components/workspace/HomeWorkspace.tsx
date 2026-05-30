import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  AudioLines,
  CheckCircle2,
  FileText,
  History as HistoryIcon,
  Play,
  Square,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { commands } from "@/bindings";
import { Button } from "@/components/ui/Button";
import { HistorySettings } from "@/components/settings";
import type { HistoryEntry } from "@/bindings";

export type SessionWindowStage =
  | "idle"
  | "active"
  | "preparing"
  | "transcribing"
  | "processing"
  | "complete";

export interface SessionWindowState {
  stage: SessionWindowStage;
  title: string;
  subtitle: string;
  progressLabel: string;
  progressValue: number;
  summaryText?: string | null;
  rawTranscriptText?: string | null;
  historyEntryId?: number | null;
}

interface HomeWorkspaceProps {
  sessionState: SessionWindowState;
  sessionClock: {
    recordingStartedAt: number | null;
    recordingStoppedAt: number | null;
    clockNow: number;
  };
  onOpenSessionEntry: (entry: HistoryEntry) => void;
}

const isLiveSession = (stage: SessionWindowStage) =>
  stage === "active" ||
  stage === "preparing" ||
  stage === "transcribing" ||
  stage === "processing";

const isSessionProcessing = (stage: SessionWindowStage) =>
  stage === "preparing" || stage === "transcribing" || stage === "processing";

type SummarySectionKey = "current_gist" | "key_points";
type MeetingView = "record" | "history";

interface SummarySection {
  key: SummarySectionKey;
  title: string;
  lines: string[];
}

const SUMMARY_SECTION_TITLES: Record<string, SummarySection> = {
  "current gist": {
    key: "current_gist",
    title: "Current gist",
    lines: [],
  },
  "key points": {
    key: "key_points",
    title: "Key points",
    lines: [],
  },
};

const parseSummarySections = (summary: string): SummarySection[] => {
  const sections: SummarySection[] = [];
  let current: SummarySection | null = null;

  for (const rawLine of summary.split(/\r?\n/)) {
    const heading = rawLine.match(/^#{1,3}\s+(.+?)\s*$/);
    if (heading) {
      const template = SUMMARY_SECTION_TITLES[heading[1].trim().toLowerCase()];
      if (template) {
        current = {
          key: template.key,
          title: template.title,
          lines: [],
        };
        sections.push(current);
        continue;
      }
      current = null;
      continue;
    }

    if (current) {
      current.lines.push(rawLine);
    }
  }

  const seen = new Set<SummarySectionKey>();
  return sections
    .map((section) => ({
      ...section,
      lines: section.lines.map((line) => line.trimEnd()),
    }))
    .filter((section) => {
      if (seen.has(section.key)) {
        return false;
      }
      seen.add(section.key);
      return true;
    });
};

const cleanBulletText = (line: string): string => line.replace(/^\s*-\s*/, "");

const SummarySectionView: React.FC<{ section: SummarySection }> = ({
  section,
}) => {
  const { t } = useTranslation();
  const visibleLines = section.lines.filter((line) => line.trim().length > 0);

  if (section.key === "current_gist") {
    return (
      <section className="space-y-3">
        <h3 className="text-[11px] font-medium uppercase tracking-[0.18em] text-text/36">
          {section.title}
        </h3>
        <p className="text-base leading-8 text-text/82">
          {visibleLines.join(" ").trim() || "No clear gist yet."}
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <h3 className="text-[11px] font-medium uppercase tracking-[0.18em] text-text/36">
        {section.title}
      </h3>
      {visibleLines.length > 0 ? (
        <ul className="space-y-4 text-[15px] leading-7 text-text/72">
          {visibleLines.map((line, index) => {
            const nested = /^\s+-\s/.test(line);
            const isContinuation =
              !nested && !line.trimStart().startsWith("-") && index > 0;
            return (
              <li
                key={`${section.key}-${index}`}
                className={`flex gap-2 ${
                  nested || isContinuation ? "pl-5 text-text/58" : ""
                }`}
              >
                <span
                  className={`mt-[0.72em] shrink-0 rounded-full bg-logo-primary/70 ${
                    nested || isContinuation ? "h-1 w-1" : "h-2 w-2"
                  }`}
                />
                <span
                  className={
                    nested || isContinuation
                      ? "text-text/62"
                      : "text-base font-semibold text-text/88"
                  }
                >
                  {cleanBulletText(line)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm leading-6 text-text/50">
          {t("workspace.home.noneYet", { defaultValue: "None yet." })}
        </p>
      )}
    </section>
  );
};

const formatElapsedTime = (elapsedMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

export const HomeWorkspace: React.FC<HomeWorkspaceProps> = ({
  sessionState,
  sessionClock,
  onOpenSessionEntry,
}) => {
  const { t } = useTranslation();
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isTranscriptModalOpen, setIsTranscriptModalOpen] = useState(false);
  const [meetingView, setMeetingView] = useState<MeetingView>("record");
  const { recordingStartedAt, recordingStoppedAt, clockNow } = sessionClock;
  const live = isLiveSession(sessionState.stage);
  const recording = sessionState.stage === "active";
  const processing = isSessionProcessing(sessionState.stage);
  const complete = sessionState.stage === "complete";
  const elapsedMs = recordingStartedAt
    ? Math.max(0, (recordingStoppedAt ?? clockNow) - recordingStartedAt)
    : 0;
  const elapsedLabel = formatElapsedTime(elapsedMs);
  const showElapsed = live || recordingStartedAt !== null;
  const statusLabel =
    sessionState.progressLabel?.trim() ||
    (recording
      ? t("workspace.home.recording", { defaultValue: "Recording" })
      : processing
        ? t("workspace.home.processing", { defaultValue: "Processing" })
        : complete
          ? t("workspace.home.complete", { defaultValue: "Complete" })
          : t("workspace.home.readyTitle", { defaultValue: "Ready to start" }));
  const rawTranscript = sessionState.rawTranscriptText?.trim() ?? "";
  const hasRawTranscript = rawTranscript.length > 0;
  const sessionBody =
    sessionState.summaryText?.trim() ||
    (complete
      ? t("workspace.home.summaryUnavailable", {
          defaultValue:
            "Summary is unavailable for this session. Open the raw transcript to review what was captured.",
        })
      : t("workspace.home.liveBody", {
          defaultValue:
            "Uttr is recording system audio and microphone audio. The summary appears here as the session is processed.",
        }));
  const summarySections = useMemo(
    () => parseSummarySections(sessionBody),
    [sessionBody],
  );
  const showingHistory = meetingView === "history" && !live;

  useEffect(() => {
    if (live) {
      setMeetingView("record");
    }
  }, [live]);

  useEffect(() => {
    if (recording) {
      setIsStarting(false);
      setIsStopping(false);
      return;
    }

    if (processing) {
      setIsStarting(false);
      setIsStopping(false);
      return;
    }

    if (complete) {
      setIsStarting(false);
      setIsStopping(false);
      return;
    }

    setIsStarting(false);
    setIsStopping(false);
  }, [complete, processing, recording, sessionState]);

  const handleStartSession = useCallback(async () => {
    if (live || isStarting) {
      return;
    }

    setIsStarting(true);
    try {
      const result = await commands.startFullSystemAudioSession();
      if (result.status === "error") {
        setIsStarting(false);
        toast.error(
          t("workspace.home.startFailed", {
            defaultValue: "Could not start the session",
          }),
          {
            description: result.error,
          },
        );
      }
    } catch (error) {
      setIsStarting(false);
      toast.error(
        t("workspace.home.startFailed", {
          defaultValue: "Could not start the session",
        }),
        {
          description: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }, [isStarting, live, t]);

  const handleOpenMeetingEntry = useCallback(
    (entry: HistoryEntry) => {
      setMeetingView("record");
      onOpenSessionEntry(entry);
    },
    [onOpenSessionEntry],
  );

  const handleStopSession = useCallback(async () => {
    if (!live || isStopping) {
      return;
    }

    setIsStopping(true);
    try {
      const result = await commands.stopFullSystemAudioSession();
      if (result.status === "error") {
        setIsStopping(false);
        toast.error(
          t("workspace.home.stopFailed", {
            defaultValue: "Could not stop the session",
          }),
          {
            description: result.error,
          },
        );
      }
    } catch (error) {
      setIsStopping(false);
      toast.error(
        t("workspace.home.stopFailed", {
          defaultValue: "Could not stop the session",
        }),
        {
          description: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }, [isStopping, live, t]);

  return (
    <div
      data-testid="home-workspace"
      className="mx-auto flex w-full max-w-5xl flex-col gap-5"
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 space-y-2">
          {showingHistory ? (
            <>
              <h1 className="text-[28px] font-semibold tracking-tight text-text">
                {t("workspace.home.meetings", {
                  defaultValue: "Meetings",
                })}
              </h1>
              <p className="max-w-2xl text-sm text-text/52">
                {t("workspace.home.meetingsHistoryDescription", {
                  defaultValue:
                    "Review saved meeting recordings and open their summaries.",
                })}
              </p>
            </>
          ) : live || complete ? (
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              {showElapsed && (
                <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-text">
                  {elapsedLabel}
                </span>
              )}
              <span
                className={
                  showElapsed
                    ? "text-sm font-medium text-logo-primary"
                    : "text-2xl font-semibold tracking-tight text-text"
                }
              >
                {statusLabel}
              </span>
            </div>
          ) : isStarting ? (
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-text">
                0:00
              </span>
              <span className="text-sm font-medium text-logo-primary">
                {t("workspace.home.starting", { defaultValue: "Starting" })}
              </span>
            </div>
          ) : (
            <>
              <h1 className="text-[28px] font-semibold tracking-tight text-text">
                {t("workspace.home.recordFullSystem", {
                  defaultValue: "Record full system",
                })}
              </h1>
              <p className="max-w-2xl text-sm text-text/52">
                {t("workspace.home.description", {
                  defaultValue:
                    "Start a full-system recording with live session summarization.",
                })}
              </p>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {!showingHistory && recording ? (
            <Button
              type="button"
              variant="danger"
              onClick={handleStopSession}
              disabled={isStopping}
              className="flex items-center gap-2 rounded-full"
            >
              <Square className="h-4 w-4" />
              <span>
                {isStopping
                  ? t("workspace.home.stopping", { defaultValue: "Stopping" })
                  : t("workspace.home.stop", { defaultValue: "Stop" })}
              </span>
            </Button>
          ) : !showingHistory && processing ? (
            <Button
              type="button"
              variant="secondary"
              disabled
              className="flex items-center gap-2 rounded-full"
            >
              <Activity className="h-4 w-4" />
              <span>
                {t("workspace.home.processing", {
                  defaultValue: "Processing",
                })}
              </span>
            </Button>
          ) : !showingHistory && isStarting ? (
            <Button
              type="button"
              variant="secondary"
              disabled
              className="flex items-center gap-2 rounded-full"
            >
              <Activity className="h-4 w-4" />
              <span>
                {t("workspace.home.starting", { defaultValue: "Starting" })}
              </span>
            </Button>
          ) : !showingHistory ? (
            <Button
              type="button"
              variant="primary-soft"
              onClick={handleStartSession}
              disabled={isStarting}
              className="flex items-center gap-2 rounded-full"
            >
              <Play className="h-4 w-4" />
              <span>
                {isStarting
                  ? t("workspace.home.starting", { defaultValue: "Starting" })
                  : t("workspace.home.start", { defaultValue: "Start" })}
              </span>
            </Button>
          ) : null}
          {!live && (
            <div
              className="flex rounded-full border border-white/8 bg-white/[0.025] p-1"
              role="group"
              aria-label={t("workspace.home.viewToggle", {
                defaultValue: "Meetings view",
              })}
            >
              <button
                type="button"
                onClick={() => setMeetingView("record")}
                className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium transition ${
                  !showingHistory
                    ? "bg-logo-primary/14 text-logo-primary shadow-[inset_0_0_0_1px_rgba(103,215,163,0.18)]"
                    : "text-text/58 hover:bg-white/[0.04] hover:text-text"
                }`}
                aria-pressed={!showingHistory}
              >
                <AudioLines className="h-4 w-4" />
                <span>
                  {t("workspace.home.recordView", {
                    defaultValue: "Record",
                  })}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setMeetingView("history")}
                className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium transition ${
                  showingHistory
                    ? "bg-logo-primary/14 text-logo-primary shadow-[inset_0_0_0_1px_rgba(103,215,163,0.18)]"
                    : "text-text/58 hover:bg-white/[0.04] hover:text-text"
                }`}
                aria-pressed={showingHistory}
              >
                <HistoryIcon className="h-4 w-4" />
                <span>
                  {t("workspace.home.historyView", {
                    defaultValue: "History",
                  })}
                </span>
              </button>
            </div>
          )}
        </div>
      </div>

      {showingHistory ? (
        <HistorySettings
          mode="meetings"
          compact
          onOpenSessionEntry={handleOpenMeetingEntry}
        />
      ) : (
        <div className="grid gap-4">
          <section className="min-h-[320px] rounded-[20px] border border-white/7 bg-white/[0.025] p-6">
            {live || complete ? (
              <div className="flex h-full flex-col gap-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-text/35">
                    {complete ? (
                      <CheckCircle2 className="h-4 w-4 text-logo-primary" />
                    ) : (
                      <Activity className="h-4 w-4 text-logo-primary" />
                    )}
                    <span>
                      {complete
                        ? t("workspace.home.summary", {
                            defaultValue: "Summary",
                          })
                        : t("workspace.home.liveSummary", {
                            defaultValue: "Live summary",
                          })}
                    </span>
                  </div>
                  {complete && hasRawTranscript && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => setIsTranscriptModalOpen(true)}
                      className="flex items-center gap-2 rounded-full"
                    >
                      <FileText className="h-3.5 w-3.5" />
                      <span>
                        {t("workspace.home.viewRawTranscript", {
                          defaultValue: "Raw transcript",
                        })}
                      </span>
                    </Button>
                  )}
                </div>
                {summarySections.length > 0 ? (
                  <div className="space-y-7">
                    {summarySections.map((section) => (
                      <SummarySectionView key={section.key} section={section} />
                    ))}
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap text-base leading-8 text-text/76">
                    {sessionBody}
                  </p>
                )}
              </div>
            ) : (
              <div className="grid h-full place-items-center py-8 text-center">
                <div className="max-w-md space-y-4">
                  <div className="mx-auto grid h-14 w-14 place-items-center rounded-full border border-white/10 bg-white/[0.035]">
                    {isStarting ? (
                      <Activity className="h-7 w-7 text-logo-primary" />
                    ) : (
                      <AudioLines className="h-7 w-7 text-logo-primary" />
                    )}
                  </div>
                  <div className="space-y-2">
                    <h2 className="text-xl font-semibold text-text">
                      {isStarting
                        ? t("workspace.home.startingSession", {
                            defaultValue: "Starting session",
                          })
                        : t("workspace.home.readyTitle", {
                            defaultValue: "Ready to start",
                          })}
                    </h2>
                    <p className="text-sm leading-6 text-text/52">
                      {isStarting
                        ? t("workspace.home.startingDescription", {
                            defaultValue:
                              "Preparing system audio and microphone capture.",
                          })
                        : t("workspace.home.readyDescription", {
                            defaultValue:
                              "Use Start for full-system audio recording and session summarization.",
                          })}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {isTranscriptModalOpen && hasRawTranscript && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="raw-transcript-title"
        >
          <div className="flex max-h-[78vh] w-full max-w-3xl flex-col overflow-hidden rounded-[18px] border border-white/10 bg-[#070d16] shadow-2xl">
            <div className="flex items-center justify-between gap-4 border-b border-white/8 px-5 py-4">
              <div className="space-y-1">
                <h2
                  id="raw-transcript-title"
                  className="text-base font-semibold text-text"
                >
                  {t("workspace.home.rawTranscriptTitle", {
                    defaultValue: "Raw transcript",
                  })}
                </h2>
                <p className="text-xs text-text/50">
                  {t("workspace.home.rawTranscriptDescription", {
                    defaultValue:
                      "Unedited text captured from the session audio.",
                  })}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsTranscriptModalOpen(false)}
                className="grid h-9 w-9 place-items-center rounded-full border border-white/10 bg-white/[0.04] text-text/70 transition hover:bg-white/[0.08] hover:text-text"
                aria-label={t("workspace.home.closeRawTranscript", {
                  defaultValue: "Close raw transcript",
                })}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="overflow-auto p-5">
              <p className="whitespace-pre-wrap text-sm leading-7 text-text/72">
                {rawTranscript}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

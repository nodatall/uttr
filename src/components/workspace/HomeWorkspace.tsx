import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  AudioLines,
  CheckCircle2,
  FileText,
  Play,
  Square,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { commands } from "@/bindings";
import { Button } from "@/components/ui/Button";

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
}

const isLiveSession = (stage: SessionWindowStage) =>
  stage === "active" ||
  stage === "preparing" ||
  stage === "transcribing" ||
  stage === "processing";

export const HomeWorkspace: React.FC<HomeWorkspaceProps> = ({
  sessionState,
}) => {
  const { t } = useTranslation();
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isTranscriptModalOpen, setIsTranscriptModalOpen] = useState(false);
  const live = isLiveSession(sessionState.stage);
  const complete = sessionState.stage === "complete";
  const progress = Math.max(0, Math.min(100, sessionState.progressValue * 100));
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

  const handleStartSession = useCallback(async () => {
    if (live || isStarting) {
      return;
    }

    setIsStarting(true);
    try {
      const result = await commands.startFullSystemAudioSession();
      if (result.status === "error") {
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
      toast.error(
        t("workspace.home.startFailed", {
          defaultValue: "Could not start the session",
        }),
        {
          description: error instanceof Error ? error.message : String(error),
        },
      );
    } finally {
      setIsStarting(false);
    }
  }, [isStarting, live, t]);

  const handleStopSession = useCallback(async () => {
    if (!live || isStopping) {
      return;
    }

    setIsStopping(true);
    try {
      const result = await commands.stopFullSystemAudioSession();
      if (result.status === "error") {
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
      toast.error(
        t("workspace.home.stopFailed", {
          defaultValue: "Could not stop the session",
        }),
        {
          description: error instanceof Error ? error.message : String(error),
        },
      );
    } finally {
      setIsStopping(false);
    }
  }, [isStopping, live, t]);

  return (
    <div
      data-testid="home-workspace"
      className="mx-auto flex w-full max-w-5xl flex-col gap-5"
    >
      <div
        className={`flex flex-wrap items-end gap-4 ${
          complete ? "justify-end" : "justify-between"
        }`}
      >
        {!complete && (
          <div className="space-y-2">
            <h1 className="text-[28px] font-semibold tracking-tight text-text">
              {live
                ? sessionState.title
                : t("workspace.home.recordFullSystem", {
                    defaultValue: "Record full system",
                  })}
            </h1>
            <p className="max-w-2xl text-sm text-text/52">
              {live
                ? sessionState.subtitle
                : t("workspace.home.description", {
                    defaultValue:
                      "Start a full-system recording with live session summarization.",
                  })}
            </p>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {live ? (
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
          ) : (
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
          )}
        </div>
      </div>

      <div className="grid gap-4">
        <section className="min-h-[320px] rounded-[20px] border border-white/7 bg-white/[0.025] p-5">
          {live || complete ? (
            <div className="flex h-full flex-col gap-5">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${
                    live
                      ? "border-logo-primary/20 bg-logo-primary/10 text-logo-primary"
                      : "border-white/10 bg-white/[0.04] text-text/70"
                  }`}
                >
                  <span
                    className={`h-2 w-2 rounded-full ${
                      live ? "bg-logo-primary" : "bg-green-300"
                    }`}
                  />
                  {live
                    ? t("workspace.home.liveSession", {
                        defaultValue: "Live session",
                      })
                    : t("workspace.home.sessionComplete", {
                        defaultValue: "Session complete",
                      })}
                </span>
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-text/66">
                  {t("workspace.home.sources", {
                    defaultValue: "System audio + microphone",
                  })}
                </span>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <p className="text-sm font-medium text-text">
                    {sessionState.progressLabel}
                  </p>
                  <p className="text-sm font-medium tabular-nums text-logo-primary">
                    {live
                      ? t("workspace.home.recording", {
                          defaultValue: "Recording",
                        })
                      : `${Math.round(progress)}%`}
                  </p>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-white/8">
                  <div
                    className="h-full rounded-full bg-logo-primary transition-all duration-300"
                    style={{ width: live ? "18%" : `${progress}%` }}
                  />
                </div>
              </div>

              <div className="min-h-0 flex-1 rounded-[16px] border border-white/7 bg-[rgba(5,10,18,0.5)] p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
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
                <p className="whitespace-pre-wrap text-sm leading-7 text-text/68">
                  {sessionBody}
                </p>
              </div>
            </div>
          ) : (
            <div className="grid h-full place-items-center py-8 text-center">
              <div className="max-w-md space-y-4">
                <div className="mx-auto grid h-14 w-14 place-items-center rounded-full border border-white/10 bg-white/[0.035]">
                  <AudioLines className="h-7 w-7 text-logo-primary" />
                </div>
                <div className="space-y-2">
                  <h2 className="text-xl font-semibold text-text">
                    {t("workspace.home.readyTitle", {
                      defaultValue: "Ready to start",
                    })}
                  </h2>
                  <p className="text-sm leading-6 text-text/52">
                    {t("workspace.home.readyDescription", {
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

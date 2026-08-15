import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  Activity,
  AudioLines,
  CheckCircle2,
  Copy,
  FileText,
  History as HistoryIcon,
  Play,
  Square,
  X,
} from "lucide-react";
import SiriWave from "siriwave";
import { toast } from "sonner";
import { commands } from "@/bindings";
import { Button } from "@/components/ui/Button";
import { HistorySettings } from "@/components/settings/history/HistorySettings";
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

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const MEETING_WAVE_CURVES = [
  { color: "255,255,255", supportLine: true },
  { color: "102,217,255" },
  { color: "170,120,255" },
  { color: "96,243,191" },
];
const MEETING_WAVE_IDLE_AMPLITUDE = 0.08;
const MEETING_WAVE_IDLE_SPEED = 0.012;
const MEETING_WAVE_MIN_AMPLITUDE = 0.55;
const MEETING_WAVE_MAX_AMPLITUDE = 2.25;
const MEETING_WAVE_MIN_SPEED = 0.055;
const MEETING_WAVE_MAX_SPEED = 0.155;
const MEETING_WAVE_ENERGY_POWER = 0.56;
const MEETING_WAVE_QUIET_GAIN = 2.2;
const MEETING_WAVE_QUIET_FLOOR = 0.08;
const MEETING_WAVE_ATTACK_KEEP = 0.18;
const MEETING_WAVE_ATTACK_NEW = 0.82;
const MEETING_WAVE_RELEASE_KEEP = 0.46;
const MEETING_WAVE_RELEASE_NEW = 0.54;
const MEETING_WAVE_SILENCE_GATE = 0.0025;
const MEETING_WAVE_BASELINE_OFFSET_PX = 5;

type SummarySectionKey = "current_gist" | "key_points";
type MeetingView = "record" | "history";
type PendingSessionAction = "start" | "stop" | null;

interface SessionActionState {
  observedState: SessionWindowState;
  pending: PendingSessionAction;
}

interface SummarySection {
  key: SummarySectionKey;
  title: string;
  lines: string[];
}

interface ParsedSummary {
  preamble: string;
  sections: SummarySection[];
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

const parseSummarySections = (summary: string): ParsedSummary => {
  const sections: SummarySection[] = [];
  const preambleLines: string[] = [];
  let current: SummarySection | null = null;
  let sawHeading = false;

  for (const rawLine of summary.split(/\r?\n/)) {
    const heading = rawLine.match(/^#{1,3}\s+(.+?)\s*$/);
    if (heading) {
      sawHeading = true;
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
    } else if (!sawHeading) {
      preambleLines.push(rawLine);
    }
  }

  const seen = new Set<SummarySectionKey>();
  const uniqueSections: SummarySection[] = [];
  for (const section of sections) {
    if (seen.has(section.key)) {
      continue;
    }

    seen.add(section.key);
    uniqueSections.push({
      ...section,
      lines: section.lines.map((line) => line.trimEnd()),
    });
  }

  return {
    preamble: preambleLines.join("\n").trim(),
    sections: uniqueSections,
  };
};

const cleanBulletText = (line: string): string => line.replace(/^\s*-\s*/, "");

type RawTranscriptSpeaker = "Me" | "Them";

interface RawTranscriptTurn {
  speaker: RawTranscriptSpeaker;
  text: string;
}

const parseLabeledRawTranscript = (transcript: string): RawTranscriptTurn[] => {
  const turns: RawTranscriptTurn[] = [];
  let current: RawTranscriptTurn | null = null;
  let sawLabel = false;

  const flush = () => {
    if (!current) {
      return;
    }
    const text = current.text.trim();
    if (text.length > 0) {
      turns.push({ ...current, text });
    }
    current = null;
  };

  for (const line of transcript.split(/\r?\n/)) {
    const match = line.match(/^(Me|Them):\s*(.*)$/);
    if (match) {
      sawLabel = true;
      flush();
      current = {
        speaker: match[1] as RawTranscriptSpeaker,
        text: match[2] ?? "",
      };
      continue;
    }

    if (!sawLabel && line.trim().length > 0) {
      return [];
    }

    if (current) {
      current.text = current.text ? `${current.text}\n${line}` : line;
    }
  }

  flush();
  return turns;
};

const SummarySectionView: React.FC<{ section: SummarySection }> = ({
  section,
}) => {
  const { t } = useTranslation();
  const visibleLines = section.lines.filter((line) => line.trim().length > 0);
  const lineOccurrences = new Map<string, number>();

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
          {visibleLines.map((line) => {
            const occurrence = lineOccurrences.get(line) ?? 0;
            lineOccurrences.set(line, occurrence + 1);
            const nested = /^\s+-\s/.test(line);
            const isContinuation =
              !nested && !line.trimStart().startsWith("-") && occurrence > 0;
            return (
              <li
                key={`${section.key}-${line}-${occurrence}`}
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

interface HomeHeaderProps {
  showingHistory: boolean;
  live: boolean;
  complete: boolean;
  showElapsed: boolean;
  elapsedLabel: string;
  statusLabel: string;
  isStarting: boolean;
  isStopping: boolean;
  recording: boolean;
  processing: boolean;
  onStartSession: () => void;
  onStopSession: () => void;
  onSelectRecord: () => void;
  onSelectHistory: () => void;
}

const MeetingAudioWave: React.FC<{
  active: boolean;
  statusLabel: string;
}> = ({ active, statusLabel }) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const waveRef = useRef<SiriWave | null>(null);
  const metricsRef = useRef({ width: 0, height: 0, ratio: 1 });
  const smoothedLevelsRef = useRef<number[]>(Array(16).fill(0));

  const disposeWave = useCallback(() => {
    waveRef.current?.dispose();
    waveRef.current = null;
  }, []);

  const syncWave = useCallback(
    (levels = smoothedLevelsRef.current) => {
      if (!active || !waveRef.current) {
        return;
      }

      const average =
        levels.reduce((sum, level) => sum + level, 0) / levels.length;
      const peak = Math.max(...levels, 0);
      const energy = clamp(
        Math.pow(Math.max(average, peak * 0.42), MEETING_WAVE_ENERGY_POWER) *
          MEETING_WAVE_QUIET_GAIN +
          MEETING_WAVE_QUIET_FLOOR,
        0,
        1,
      );
      const amplitude = clamp(
        MEETING_WAVE_MIN_AMPLITUDE +
          energy * (MEETING_WAVE_MAX_AMPLITUDE - MEETING_WAVE_MIN_AMPLITUDE),
        MEETING_WAVE_MIN_AMPLITUDE,
        MEETING_WAVE_MAX_AMPLITUDE,
      );
      const speed = clamp(
        MEETING_WAVE_MIN_SPEED +
          energy * (MEETING_WAVE_MAX_SPEED - MEETING_WAVE_MIN_SPEED),
        MEETING_WAVE_MIN_SPEED,
        MEETING_WAVE_MAX_SPEED,
      );

      if (!waveRef.current.run) {
        waveRef.current.start();
      }
      waveRef.current.setAmplitude(amplitude);
      waveRef.current.setSpeed(speed);
    },
    [active],
  );

  const createWave = useCallback(() => {
    const host = hostRef.current;
    const { width, height, ratio } = metricsRef.current;
    if (!active || !host || width <= 0 || height <= 0) {
      return;
    }

    disposeWave();
    waveRef.current = new SiriWave({
      container: host,
      style: "ios9",
      ratio,
      width,
      height,
      autostart: true,
      amplitude: MEETING_WAVE_IDLE_AMPLITUDE,
      speed: MEETING_WAVE_IDLE_SPEED,
      pixelDepth: 0.02,
      lerpSpeed: 0.11,
      globalCompositeOperation: "lighter",
      curveDefinition: MEETING_WAVE_CURVES,
      ranges: {
        noOfCurves: [4, 7],
        amplitude: [1.7, 3.4],
        offset: [-2.4, 2.4],
        width: [0.9, 2.2],
        speed: [0.55, 1.1],
        despawnTimeout: [900, 2200],
      },
    });
    syncWave();
  }, [active, disposeWave, syncWave]);

  useEffect(() => {
    if (!active) {
      disposeWave();
      return;
    }

    const host = hostRef.current;
    if (!host) {
      return;
    }

    const syncMetrics = () => {
      const nextWidth = host.clientWidth;
      const nextHeight = host.clientHeight;
      const nextRatio = window.devicePixelRatio || 1;
      const yShift = MEETING_WAVE_BASELINE_OFFSET_PX / nextRatio;
      host.style.setProperty("--meeting-wave-y-shift", `${yShift}px`);

      const current = metricsRef.current;
      const changed =
        current.width !== nextWidth ||
        current.height !== nextHeight ||
        Math.abs(current.ratio - nextRatio) > 0.001;

      if (!changed) {
        return;
      }

      metricsRef.current = {
        width: nextWidth,
        height: nextHeight,
        ratio: nextRatio,
      };
      createWave();
    };

    syncMetrics();

    const resizeObserver = new ResizeObserver(syncMetrics);
    resizeObserver.observe(host);
    window.addEventListener("resize", syncMetrics);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", syncMetrics);
      disposeWave();
    };
  }, [active, createWave, disposeWave]);

  useEffect(() => {
    if (!active) {
      return;
    }

    let disposed = false;
    let unlistenFn: (() => void) | undefined;

    listen<number[]>("mic-level", (event) => {
      if (disposed) {
        return;
      }

      const nextLevels = event.payload;
      smoothedLevelsRef.current = smoothedLevelsRef.current.map(
        (previous, i) => {
          const target = nextLevels[i] || 0;
          if (
            target < MEETING_WAVE_SILENCE_GATE &&
            previous < MEETING_WAVE_SILENCE_GATE * 1.5
          ) {
            return 0;
          }

          if (target > previous) {
            return (
              previous * MEETING_WAVE_ATTACK_KEEP +
              target * MEETING_WAVE_ATTACK_NEW
            );
          }

          const released =
            previous * MEETING_WAVE_RELEASE_KEEP +
            target * MEETING_WAVE_RELEASE_NEW;
          return released < MEETING_WAVE_SILENCE_GATE * 0.5 ? 0 : released;
        },
      );
      syncWave(smoothedLevelsRef.current);
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }
      unlistenFn = unlisten;
    });

    return () => {
      disposed = true;
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, [active, syncWave]);

  useEffect(() => {
    if (!active || waveRef.current) {
      return;
    }
    createWave();
  }, [active, createWave]);

  return (
    <div
      className="relative h-9 w-[176px] overflow-hidden"
      role="img"
      aria-label={statusLabel}
      data-testid="meeting-audio-wave"
    >
      <div
        ref={hostRef}
        className="absolute inset-x-0 top-[-30%] h-[160%] [&_canvas]:block [&_canvas]:h-full [&_canvas]:w-full [&_canvas]:translate-y-[var(--meeting-wave-y-shift,0px)] [&_canvas]:overflow-hidden [&_canvas]:opacity-100 [&_canvas]:drop-shadow-[0_0_5px_rgba(86,208,255,0.28)] [&_canvas]:saturate-[1.32]"
        aria-hidden
      />
      <span className="sr-only">{statusLabel}</span>
    </div>
  );
};

const HomeHeader: React.FC<HomeHeaderProps> = ({
  showingHistory,
  live,
  complete,
  showElapsed,
  elapsedLabel,
  statusLabel,
  isStarting,
  isStopping,
  recording,
  processing,
  onStartSession,
  onStopSession,
  onSelectRecord,
  onSelectHistory,
}) => {
  const { t } = useTranslation();

  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0 space-y-2">
        {showingHistory ? (
          <>
            <h1 className="text-[28px] font-semibold tracking-tight text-text">
              {t("workspace.home.meetings", { defaultValue: "Meetings" })}
            </h1>
            <p className="max-w-2xl text-sm text-text/52">
              {t("workspace.home.meetingsHistoryDescription", {
                defaultValue:
                  "Review saved meeting recordings and open their summaries.",
              })}
            </p>
          </>
        ) : live || complete ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {showElapsed && (
              <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-text">
                {elapsedLabel}
              </span>
            )}
            {recording ? (
              <MeetingAudioWave active={recording} statusLabel={statusLabel} />
            ) : (
              <span
                className={
                  showElapsed
                    ? "text-sm font-medium text-logo-primary"
                    : "text-2xl font-semibold tracking-tight text-text"
                }
              >
                {statusLabel}
              </span>
            )}
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
            onClick={onStopSession}
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
              {t("workspace.home.processing", { defaultValue: "Processing" })}
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
            onClick={onStartSession}
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
        <fieldset
          className="flex min-w-[204px] rounded-full border border-white/8 bg-white/[0.025] p-1"
          aria-label={t("workspace.home.viewToggle", {
            defaultValue: "Meetings view",
          })}
          disabled={live}
        >
          <legend className="sr-only">
            {t("workspace.home.viewToggle", {
              defaultValue: "Meetings view",
            })}
          </legend>
          <button
            type="button"
            onClick={onSelectRecord}
            className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium transition ${
              !showingHistory
                ? "bg-logo-primary/14 text-logo-primary shadow-[inset_0_0_0_1px_rgba(103,215,163,0.18)]"
                : "text-text/58 hover:bg-white/[0.04] hover:text-text disabled:hover:bg-transparent disabled:hover:text-text/58"
            }`}
            aria-pressed={!showingHistory}
          >
            <AudioLines className="h-4 w-4" />
            <span>
              {t("workspace.home.recordView", { defaultValue: "Record" })}
            </span>
          </button>
          <button
            type="button"
            onClick={onSelectHistory}
            className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium transition ${
              showingHistory
                ? "bg-logo-primary/14 text-logo-primary shadow-[inset_0_0_0_1px_rgba(103,215,163,0.18)]"
                : "text-text/58 hover:bg-white/[0.04] hover:text-text disabled:hover:bg-transparent disabled:hover:text-text/58"
            }`}
            aria-pressed={showingHistory}
          >
            <HistoryIcon className="h-4 w-4" />
            <span>
              {t("workspace.home.historyView", { defaultValue: "History" })}
            </span>
          </button>
        </fieldset>
      </div>
    </div>
  );
};

interface SessionSummaryPanelProps {
  live: boolean;
  complete: boolean;
  isStarting: boolean;
  hasRawTranscript: boolean;
  sessionBody: string;
  summaryPreamble: string;
  summarySections: SummarySection[];
  onOpenRawTranscript: () => void;
}

const SessionSummaryPanel: React.FC<SessionSummaryPanelProps> = ({
  live,
  complete,
  isStarting,
  hasRawTranscript,
  sessionBody,
  summaryPreamble,
  summarySections,
  onOpenRawTranscript,
}) => {
  const { t } = useTranslation();

  return (
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
                    ? t("workspace.home.summary", { defaultValue: "Summary" })
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
                  onClick={onOpenRawTranscript}
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
                {summaryPreamble && (
                  <p
                    role="alert"
                    data-testid="session-summary-preamble"
                    className="whitespace-pre-wrap rounded-2xl border border-amber-400/20 bg-amber-300/8 px-3.5 py-3 text-sm leading-6 text-amber-100/88"
                  >
                    {summaryPreamble}
                  </p>
                )}
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
  );
};

interface RawTranscriptDialogProps {
  rawTranscript: string;
  labeledTranscriptTurns: RawTranscriptTurn[];
  onClose: () => void;
}

const RawTranscriptDialog: React.FC<RawTranscriptDialogProps> = ({
  rawTranscript,
  labeledTranscriptTurns,
  onClose,
}) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copiedResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  useEffect(
    () => () => {
      if (copiedResetTimerRef.current) {
        clearTimeout(copiedResetTimerRef.current);
      }
    },
    [],
  );

  const copyRawTranscript = useCallback(async () => {
    if (!rawTranscript) {
      return;
    }

    try {
      await writeText(rawTranscript);
      setCopied(true);
      if (copiedResetTimerRef.current) {
        clearTimeout(copiedResetTimerRef.current);
      }
      copiedResetTimerRef.current = setTimeout(() => {
        setCopied(false);
        copiedResetTimerRef.current = null;
      }, 1000);
    } catch (error) {
      toast.error(String(error));
    }
  }, [rawTranscript]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/42 p-6 backdrop-blur-sm"
      aria-modal="true"
      aria-labelledby="raw-transcript-title"
      role="dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="flex max-h-[78vh] w-[min(880px,calc(100vw-3rem))] flex-col overflow-hidden rounded-[18px] border border-white/10 bg-[#070d16] shadow-2xl">
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
                defaultValue: "Unedited text captured from the session audio.",
              })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={copyRawTranscript}
              data-copy-state={copied ? "copied" : "idle"}
              className={`group grid h-9 w-9 cursor-pointer place-items-center rounded-full border transition-all duration-150 ${
                copied
                  ? "border-logo-primary/35 bg-logo-primary/12 text-logo-primary shadow-[inset_0_0_0_1px_rgba(103,215,163,0.12)]"
                  : "border-white/10 bg-white/[0.04] text-text/70 hover:border-white/20 hover:bg-white/[0.09] hover:text-text"
              }`}
              aria-label={t("workspace.home.copyRawTranscript", {
                defaultValue: "Copy raw transcript",
              })}
            >
              <Copy
                className={`h-4 w-4 transition-transform duration-150 ${
                  copied ? "scale-110" : "group-hover:scale-110"
                }`}
              />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="grid h-9 w-9 cursor-pointer place-items-center rounded-full border border-white/10 bg-white/[0.04] text-text/70 transition hover:bg-white/[0.08] hover:text-text"
              aria-label={t("workspace.home.closeRawTranscript", {
                defaultValue: "Close raw transcript",
              })}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="overflow-auto p-5">
          {labeledTranscriptTurns.length > 0 ? (
            <div className="grid gap-4">
              {labeledTranscriptTurns.map((turn, index) => (
                <article
                  key={`${turn.speaker}-${index}`}
                  className="grid grid-cols-[4.25rem_minmax(0,1fr)] items-start gap-3 max-sm:grid-cols-1 max-sm:gap-2"
                >
                  <span
                    className={`inline-grid min-h-7 place-items-center justify-self-start rounded-full border px-3 text-xs font-semibold ${
                      turn.speaker === "Me"
                        ? "border-logo-primary/25 bg-logo-primary/12 text-logo-primary"
                        : "border-white/10 bg-white/[0.045] text-text/68"
                    }`}
                  >
                    {turn.speaker}
                  </span>
                  <p className="whitespace-pre-wrap text-sm leading-7 text-text/72">
                    {turn.text}
                  </p>
                </article>
              ))}
            </div>
          ) : (
            <p className="whitespace-pre-wrap text-sm leading-7 text-text/72">
              {rawTranscript}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

export const HomeWorkspace: React.FC<HomeWorkspaceProps> = ({
  sessionState,
  sessionClock,
  onOpenSessionEntry,
}) => {
  const { t } = useTranslation();
  const [sessionAction, setSessionAction] = useState<SessionActionState>({
    observedState: sessionState,
    pending: null,
  });
  const [isTranscriptModalOpen, setIsTranscriptModalOpen] = useState(false);
  const [selectedMeetingView, setSelectedMeetingView] =
    useState<MeetingView>("record");
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
  const parsedSummary = useMemo(
    () => parseSummarySections(sessionBody),
    [sessionBody],
  );
  const labeledTranscriptTurns = useMemo(
    () => parseLabeledRawTranscript(rawTranscript),
    [rawTranscript],
  );
  const meetingView = live ? "record" : selectedMeetingView;
  const showingHistory = meetingView === "history";
  const pendingAction =
    sessionState === sessionAction.observedState ? sessionAction.pending : null;
  const isStarting = pendingAction === "start";
  const isStopping = pendingAction === "stop";

  const handleStartSession = useCallback(async () => {
    if (live || isStarting) {
      return;
    }

    setSessionAction({
      observedState: sessionState,
      pending: "start",
    });
    try {
      const result = await commands.startFullSystemAudioSession();
      if (result.status === "error") {
        setSessionAction((current) => ({ ...current, pending: null }));
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
      setSessionAction((current) => ({ ...current, pending: null }));
      toast.error(
        t("workspace.home.startFailed", {
          defaultValue: "Could not start the session",
        }),
        {
          description: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }, [isStarting, live, sessionState, t]);

  const handleOpenMeetingEntry = useCallback(
    (entry: HistoryEntry) => {
      setSelectedMeetingView("record");
      onOpenSessionEntry(entry);
    },
    [onOpenSessionEntry],
  );

  const handleStopSession = useCallback(async () => {
    if (!live || isStopping) {
      return;
    }

    setSessionAction({
      observedState: sessionState,
      pending: "stop",
    });
    try {
      const result = await commands.stopFullSystemAudioSession();
      if (result.status === "error") {
        setSessionAction((current) => ({ ...current, pending: null }));
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
      setSessionAction((current) => ({ ...current, pending: null }));
      toast.error(
        t("workspace.home.stopFailed", {
          defaultValue: "Could not stop the session",
        }),
        {
          description: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }, [isStopping, live, sessionState, t]);

  return (
    <div
      data-testid="home-workspace"
      className="mx-auto flex w-full max-w-5xl flex-col gap-5"
    >
      <HomeHeader
        showingHistory={showingHistory}
        live={live}
        complete={complete}
        showElapsed={showElapsed}
        elapsedLabel={elapsedLabel}
        statusLabel={statusLabel}
        isStarting={isStarting}
        isStopping={isStopping}
        recording={recording}
        processing={processing}
        onStartSession={handleStartSession}
        onStopSession={handleStopSession}
        onSelectRecord={() => setSelectedMeetingView("record")}
        onSelectHistory={() => setSelectedMeetingView("history")}
      />

      {showingHistory ? (
        <HistorySettings
          mode="meetings"
          compact
          onOpenSessionEntry={handleOpenMeetingEntry}
        />
      ) : (
        <SessionSummaryPanel
          live={live}
          complete={complete}
          isStarting={isStarting}
          hasRawTranscript={hasRawTranscript}
          sessionBody={sessionBody}
          summaryPreamble={parsedSummary.preamble}
          summarySections={parsedSummary.sections}
          onOpenRawTranscript={() => setIsTranscriptModalOpen(true)}
        />
      )}

      {isTranscriptModalOpen && hasRawTranscript && (
        <RawTranscriptDialog
          rawTranscript={rawTranscript}
          labeledTranscriptTurns={labeledTranscriptTurns}
          onClose={() => setIsTranscriptModalOpen(false)}
        />
      )}
    </div>
  );
};

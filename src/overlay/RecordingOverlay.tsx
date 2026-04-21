import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import React, { useEffect, useMemo, useRef, useState } from "react";
import "./RecordingOverlay.css";
import i18n, { syncLanguageFromSettings } from "@/i18n";
import { getLanguageDirection } from "@/lib/utils/rtl";
import SiriWave from "siriwave";

type OverlayState =
  | "warming"
  | "recording"
  | "trial_ended"
  | "transcribing"
  | "processing"
  | "full_system_progress";
type OverlayAlertKind = "no_input" | "trial_ended";
type FullSystemProgressStage =
  | "preparing"
  | "transcribing"
  | "processing"
  | "complete";

interface FullSystemProgressPayload {
  stage: FullSystemProgressStage;
  title: string;
  subtitle: string;
  progressLabel: string;
  progressValue: number;
  footerNote: string;
  transcriptText?: string | null;
  historyEntryId?: number | null;
}

const INPUT_ATTACK_SMOOTHING_KEEP = 0.18;
const INPUT_ATTACK_SMOOTHING_NEW = 0.82;
const INPUT_RELEASE_SMOOTHING_KEEP = 0.46;
const INPUT_RELEASE_SMOOTHING_NEW = 0.54;
const WAVE_ENERGY_POWER = 0.56;
const QUIET_SPEECH_GAIN = 2.2;
const QUIET_FLOOR = 0.12;
const SILENCE_ACTIVITY_START = 0.0025;
const SILENCE_ACTIVITY_RANGE = 0.012;
const SILENCE_LEVEL_GATE = 0.006;
const SPEECH_WAKE_AVERAGE = 0.0014;
const SPEECH_WAKE_PEAK = 0.008;
const SPEECH_SLEEP_AVERAGE = 0.00055;
const SPEECH_SLEEP_PEAK = 0.0025;
const SPEECH_SLEEP_HOLD_MS = 500;
const WAVE_ENERGY_MIN = 0;
const WAVE_ENERGY_MAX = 1;
const WAVE_AMPLITUDE_MIN = 0.65;
const WAVE_AMPLITUDE_RANGE = 3.2;
const WAVE_AMPLITUDE_CAP = 2.95;
const WAVE_AMPLITUDE_BOOST = 1.45;
const WAVE_MAX_AMPLITUDE_FACTOR = 0.6;
const WAVE_PEAK_GUARD = 0.9;
const WAVE_SPEED_MIN = 0.065;
const WAVE_SPEED_RANGE = 0.105;
const WAVE_SPEED_CAP = 0.17;
const WAVE_IDLE_AMPLITUDE = 0.08;
const WAVE_IDLE_SPEED = 0.012;
const SUSTAINED_SPEECH_MIN_ENERGY = 0.12;
const EFFECTIVE_WAVE_ENERGY_CAP = 0.56;
const IOS9_BASELINE_OFFSET_PX = 6;
const RECORDING_CURVES = [
  { color: "255,255,255", supportLine: true },
  { color: "102,217,255" },
  { color: "170,120,255" },
  { color: "96,243,191" },
];

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
const lerp = (start: number, end: number, amount: number) =>
  start + (end - start) * amount;

const RecordingOverlay: React.FC = () => {
  const [waveHostWidth, setWaveHostWidth] = useState(0);
  const [waveHostHeight, setWaveHostHeight] = useState(0);
  const [devicePixelRatio, setDevicePixelRatio] = useState(
    window.devicePixelRatio || 1,
  );
  const [isVisible, setIsVisible] = useState(true);
  const [state, setState] = useState<OverlayState>("recording");
  const [levels, setLevels] = useState<number[]>(Array(16).fill(0));
  const [overlayAlert, setOverlayAlert] = useState<OverlayAlertKind | null>(
    null,
  );
  const [hasDetectedSpeech, setHasDetectedSpeech] = useState(false);
  const [fullSystemProgress, setFullSystemProgress] =
    useState<FullSystemProgressPayload | null>(null);
  const [overlayActionPending, setOverlayActionPending] = useState(false);
  const waveContainerRef = useRef<HTMLDivElement | null>(null);
  const siriWaveRef = useRef<SiriWave | null>(null);
  const smoothedLevelsRef = useRef<number[]>(Array(16).fill(0));
  const lastSpeechEnergyRef = useRef(0);
  const overlayStateRef = useRef<OverlayState>("recording");
  const hasDetectedSpeechRef = useRef(false);
  const quietSinceRef = useRef<number | null>(null);
  const isVisibleRef = useRef(true);
  const lastHideAtRef = useRef(0);
  const previousStateRef = useRef<OverlayState>("recording");
  const direction = getLanguageDirection(i18n.language);
  const isRecordingState = state === "recording";
  const isWarmingState = state === "warming";
  const isProcessingState = state === "transcribing" || state === "processing";
  const isFullSystemProgressState = state === "full_system_progress";
  const shouldShowOverlayAlert = overlayAlert !== null;
  const shouldShowWarmingPane = isWarmingState && !shouldShowOverlayAlert;

  useEffect(() => {
    isVisibleRef.current = isVisible;
  }, [isVisible]);

  useEffect(() => {
    hasDetectedSpeechRef.current = hasDetectedSpeech;
  }, [hasDetectedSpeech]);

  useEffect(() => {
    overlayStateRef.current = state;
  }, [state]);

  useEffect(() => {
    let isDisposed = false;
    const unlistenFns: Array<() => void> = [];

    const setupEventListeners = async () => {
      // Listen for show-overlay event from Rust
      const unlistenShow = await listen("show-overlay", async (event) => {
        const overlayState = event.payload as OverlayState;
        isVisibleRef.current = true;
        setState(overlayState);
        smoothedLevelsRef.current = Array(16).fill(0);
        setLevels(Array(16).fill(0));
        setOverlayAlert(overlayState === "trial_ended" ? "trial_ended" : null);
        setHasDetectedSpeech(false);
        setOverlayActionPending(false);
        if (overlayState !== "full_system_progress") {
          setFullSystemProgress(null);
        }
        lastSpeechEnergyRef.current = 0;
        quietSinceRef.current = null;
        setIsVisible(true);

        // Sync language from settings without blocking the overlay from
        // becoming visible on the hotkey path.
        void syncLanguageFromSettings();
      });

      // Listen for hide-overlay event from Rust
      const unlistenHide = await listen("hide-overlay", () => {
        isVisibleRef.current = false;
        lastHideAtRef.current = Date.now();
        setOverlayAlert(null);
        setHasDetectedSpeech(false);
        setFullSystemProgress(null);
        setOverlayActionPending(false);
        lastSpeechEnergyRef.current = 0;
        quietSinceRef.current = null;
        setIsVisible(false);
      });

      const unlistenAlert = await listen<OverlayAlertKind>(
        "overlay-alert",
        (event) => {
          setOverlayAlert(event.payload);
          setIsVisible(true);
        },
      );

      const unlistenFullSystemProgress =
        await listen<FullSystemProgressPayload>(
          "overlay-full-system-progress",
          (event) => {
            isVisibleRef.current = true;
            setOverlayAlert(null);
            setOverlayActionPending(false);
            setState("full_system_progress");
            setFullSystemProgress(event.payload);
            setIsVisible(true);
          },
        );

      // Listen for mic-level updates
      const unlistenLevel = await listen<number[]>("mic-level", (event) => {
        const newLevels = event.payload as number[];
        // Fallback only when hidden: if this webview missed `show-overlay`,
        // level activity implies active recording.
        if (!isVisibleRef.current) {
          // Ignore delayed mic-level events that often arrive right after hide
          // to prevent a one-frame recording-wave flash at the end.
          if (Date.now() - lastHideAtRef.current < 450) {
            return;
          }
          isVisibleRef.current = true;
          setState("recording");
          setIsVisible(true);
        }

        // Apply smoothing to reduce jitter
        const smoothed = smoothedLevelsRef.current.map((prev, i) => {
          const target = newLevels[i] || 0;
          if (target < SILENCE_LEVEL_GATE && prev < SILENCE_LEVEL_GATE * 1.5) {
            return 0;
          }

          if (target > prev) {
            if (prev < 0.015 && target > 0.05) {
              return target;
            }

            return (
              prev * INPUT_ATTACK_SMOOTHING_KEEP +
              target * INPUT_ATTACK_SMOOTHING_NEW
            );
          }

          const next =
            prev * INPUT_RELEASE_SMOOTHING_KEEP +
            target * INPUT_RELEASE_SMOOTHING_NEW;
          return next < SILENCE_LEVEL_GATE * 0.5 ? 0 : next;
        });

        smoothedLevelsRef.current = smoothed;
        setLevels(smoothed);

        if (overlayStateRef.current !== "recording") {
          quietSinceRef.current = null;
          return;
        }

        const rawAverage =
          newLevels.reduce((sum, level) => sum + level, 0) / newLevels.length;
        const rawPeak = Math.max(...newLevels, 0);
        const rawEnergy = clamp(
          Math.pow(Math.max(rawAverage, rawPeak * 0.42), WAVE_ENERGY_POWER) *
            QUIET_SPEECH_GAIN +
            QUIET_FLOOR,
          WAVE_ENERGY_MIN,
          WAVE_ENERGY_MAX,
        );

        if (!hasDetectedSpeechRef.current) {
          if (
            rawAverage >= SPEECH_WAKE_AVERAGE ||
            rawPeak >= SPEECH_WAKE_PEAK
          ) {
            lastSpeechEnergyRef.current = Math.max(
              rawEnergy,
              SUSTAINED_SPEECH_MIN_ENERGY,
            );
            quietSinceRef.current = null;
            hasDetectedSpeechRef.current = true;
            setHasDetectedSpeech(true);
          }
          return;
        }

        if (
          rawAverage <= SPEECH_SLEEP_AVERAGE &&
          rawPeak <= SPEECH_SLEEP_PEAK
        ) {
          const now = Date.now();
          if (quietSinceRef.current === null) {
            quietSinceRef.current = now;
            return;
          }

          if (now - quietSinceRef.current >= SPEECH_SLEEP_HOLD_MS) {
            quietSinceRef.current = null;
            lastSpeechEnergyRef.current = 0;
            hasDetectedSpeechRef.current = false;
            setHasDetectedSpeech(false);
          }
          return;
        }

        lastSpeechEnergyRef.current = Math.max(
          lastSpeechEnergyRef.current * 0.985,
          rawEnergy,
          SUSTAINED_SPEECH_MIN_ENERGY,
        );
        quietSinceRef.current = null;
      });

      if (isDisposed) {
        unlistenShow();
        unlistenHide();
        unlistenAlert();
        unlistenFullSystemProgress();
        unlistenLevel();
        return;
      }

      unlistenFns.push(
        unlistenShow,
        unlistenHide,
        unlistenAlert,
        unlistenFullSystemProgress,
        unlistenLevel,
      );
    };

    void setupEventListeners();

    return () => {
      isDisposed = true;
      unlistenFns.forEach((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const host = waveContainerRef.current;
    if (!host) {
      return;
    }

    const syncWaveMetrics = () => {
      const nextWidth = host.clientWidth;
      const nextHeight = host.clientHeight;
      const nextDpr = window.devicePixelRatio || 1;
      const yShift = (IOS9_BASELINE_OFFSET_PX + 1) / nextDpr;
      host.style.setProperty("--siriwave-y-shift", `${yShift}px`);

      setWaveHostWidth((prev) => (prev !== nextWidth ? nextWidth : prev));
      setWaveHostHeight((prev) => (prev !== nextHeight ? nextHeight : prev));
      setDevicePixelRatio((prev) =>
        Math.abs(prev - nextDpr) > 0.001 ? nextDpr : prev,
      );
    };

    syncWaveMetrics();

    const resizeObserver = new ResizeObserver(syncWaveMetrics);
    resizeObserver.observe(host);
    window.addEventListener("resize", syncWaveMetrics);
    const dprPoll = window.setInterval(syncWaveMetrics, 300);

    return () => {
      window.removeEventListener("resize", syncWaveMetrics);
      resizeObserver.disconnect();
      window.clearInterval(dprPoll);
    };
  }, []);

  useEffect(() => {
    const host = waveContainerRef.current;
    if (!host || !isVisible) {
      siriWaveRef.current?.dispose();
      siriWaveRef.current = null;
      return undefined;
    }

    if (waveHostWidth <= 0 || waveHostHeight <= 0) {
      return undefined;
    }

    siriWaveRef.current?.dispose();
    siriWaveRef.current = new SiriWave({
      container: host,
      style: "ios9",
      ratio: devicePixelRatio,
      width: waveHostWidth,
      height: waveHostHeight,
      autostart: true,
      amplitude: WAVE_AMPLITUDE_MIN,
      speed: WAVE_SPEED_MIN,
      pixelDepth: 0.02,
      lerpSpeed: 0.11,
      globalCompositeOperation: "lighter",
      curveDefinition: RECORDING_CURVES,
      ranges: {
        noOfCurves: [4, 7],
        amplitude: [1.8, 3.8],
        offset: [-2.5, 2.5],
        width: [0.9, 2.3],
        speed: [0.55, 1.1],
        despawnTimeout: [900, 2200],
      },
    });

    return () => {
      siriWaveRef.current?.dispose();
      siriWaveRef.current = null;
    };
  }, [isVisible, waveHostWidth, waveHostHeight, devicePixelRatio]);

  const averageLevel = useMemo(
    () => levels.reduce((sum, level) => sum + level, 0) / levels.length,
    [levels],
  );
  const peakLevel = useMemo(() => Math.max(...levels, 0), [levels]);

  const waveEnergy = useMemo(() => {
    const boosted =
      Math.pow(averageLevel, WAVE_ENERGY_POWER) * QUIET_SPEECH_GAIN +
      QUIET_FLOOR;
    return clamp(boosted, WAVE_ENERGY_MIN, WAVE_ENERGY_MAX);
  }, [averageLevel]);
  const waveMotionBlend = useMemo(() => {
    const activityLevel = Math.max(averageLevel * 1.9, peakLevel * 0.95);
    const activity = clamp(
      (activityLevel - SILENCE_ACTIVITY_START) / SILENCE_ACTIVITY_RANGE,
      0,
      1,
    );
    return Math.pow(activity, 0.7);
  }, [averageLevel, peakLevel]);
  const showWave = isRecordingState;

  useEffect(() => {
    if (!showWave && hasDetectedSpeechRef.current) {
      quietSinceRef.current = null;
      lastSpeechEnergyRef.current = 0;
      hasDetectedSpeechRef.current = false;
      setHasDetectedSpeech(false);
    }
  }, [showWave]);

  const effectiveWaveEnergy = useMemo(() => {
    if (!hasDetectedSpeech) {
      return waveEnergy;
    }

    return Math.min(
      Math.max(waveEnergy, lastSpeechEnergyRef.current),
      EFFECTIVE_WAVE_ENERGY_CAP,
    );
  }, [hasDetectedSpeech, waveEnergy]);

  const handleCopyTranscript = async () => {
    if (!fullSystemProgress?.transcriptText || overlayActionPending) {
      return;
    }

    try {
      setOverlayActionPending(true);
      await navigator.clipboard.writeText(fullSystemProgress.transcriptText);
      await invoke("dismiss_overlay");
    } catch (error) {
      console.error("Failed to copy full-system transcript:", error);
      setOverlayActionPending(false);
    }
  };

  const handleViewHistoryEntry = async () => {
    if (overlayActionPending) {
      return;
    }

    try {
      setOverlayActionPending(true);
      await emit("show-history-entry", {
        entryId: fullSystemProgress?.historyEntryId ?? null,
      });
      await invoke("show_main_window");
      await invoke("dismiss_overlay");
    } catch (error) {
      console.error("Failed to open history entry:", error);
      setOverlayActionPending(false);
    }
  };

  const handleDismissOverlay = async () => {
    if (overlayActionPending) {
      return;
    }

    try {
      setOverlayActionPending(true);
      await invoke("dismiss_overlay");
    } catch (error) {
      console.error("Failed to dismiss overlay:", error);
      setOverlayActionPending(false);
    }
  };

  useEffect(() => {
    if (!isVisible) {
      return;
    }

    const siriWave = siriWaveRef.current;
    if (!siriWave) {
      return;
    }

    if (isProcessingState || shouldShowOverlayAlert) {
      if (previousStateRef.current === "recording" && siriWave.run) {
        siriWave.stop();
      }
      previousStateRef.current = state;
      return;
    }

    if (!showWave) {
      if (siriWave.run) {
        siriWave.stop();
      }
      siriWave.setAmplitude(WAVE_AMPLITUDE_MIN * 0.45);
      siriWave.setSpeed(WAVE_SPEED_MIN * 0.5);
      previousStateRef.current = state;
      return;
    }

    if (!siriWave.run) {
      siriWave.start();
    }

    const activeAmplitude = clamp(
      (WAVE_AMPLITUDE_MIN + effectiveWaveEnergy * WAVE_AMPLITUDE_RANGE) *
        WAVE_AMPLITUDE_BOOST,
      WAVE_AMPLITUDE_MIN,
      WAVE_AMPLITUDE_CAP *
        WAVE_AMPLITUDE_BOOST *
        WAVE_MAX_AMPLITUDE_FACTOR *
        WAVE_PEAK_GUARD,
    );
    const activeSpeed = clamp(
      WAVE_SPEED_MIN + effectiveWaveEnergy * WAVE_SPEED_RANGE,
      WAVE_SPEED_MIN,
      WAVE_SPEED_CAP,
    );
    const amplitude = hasDetectedSpeech ? activeAmplitude : WAVE_IDLE_AMPLITUDE;
    const speed = hasDetectedSpeech ? activeSpeed : WAVE_IDLE_SPEED;
    siriWave.setAmplitude(amplitude);
    siriWave.setSpeed(speed);
    previousStateRef.current = state;
  }, [
    isVisible,
    isProcessingState,
    shouldShowOverlayAlert,
    showWave,
    hasDetectedSpeech,
    state,
    waveMotionBlend,
    effectiveWaveEnergy,
  ]);

  const overlayAlertTitle =
    overlayAlert === "trial_ended"
      ? i18n.t("overlay.trialEndedTitle", {
          defaultValue: "Trial ended",
        })
      : overlayAlert === "no_input"
        ? i18n.t("overlay.noInputTitle", {
            defaultValue: "No input detected",
          })
        : "";
  const overlayAlertDescription =
    overlayAlert === "trial_ended"
      ? i18n.t("overlay.trialEndedDescription", {
          defaultValue: "Upgrade to Pro in Settings to keep transcribing.",
        })
      : overlayAlert === "no_input"
        ? i18n.t("overlay.noInputDescription", {
            defaultValue: "Check your microphone settings.",
          })
        : "";
  const overlayAlertClassName =
    overlayAlert === "trial_ended"
      ? "overlay-alert-pane-warning overlay-alert-pane-trial-ended"
      : overlayAlert === "no_input"
        ? "overlay-alert-pane-warning"
        : "";
  const warmingTitle = i18n.t("overlay.warmingMic", {
    defaultValue: "Warming mic...",
  });
  const fullSystemEyebrow = i18n.t("overlay.fullSystemEyebrow", {
    defaultValue: "Full system",
  });
  const progressPercent = Math.round(
    (fullSystemProgress?.progressValue ?? 0) * 100,
  );

  if (isFullSystemProgressState && fullSystemProgress) {
    return (
      <div
        dir={direction}
        className={`recording-overlay recording-overlay-full-system ${isVisible ? "fade-in" : ""}`}
      >
        <div className="overlay-progress-card" role="status" aria-live="polite">
          <div className="overlay-progress-status-row">
            <div className="overlay-progress-eyebrow">{fullSystemEyebrow}</div>
          </div>
          <div className="overlay-progress-headline">
            <div className="overlay-progress-headline-top">
              <div className="overlay-progress-headline-title">
                <h1>{fullSystemProgress.title}</h1>
              </div>
              {fullSystemProgress.stage === "complete" && (
                <div className="overlay-progress-actions">
                  <button
                    type="button"
                    className="overlay-progress-button overlay-progress-button-primary"
                    onClick={handleCopyTranscript}
                    disabled={
                      overlayActionPending || !fullSystemProgress.transcriptText
                    }
                  >
                    {i18n.t("overlay.fullSystemProgress.copy", {
                      defaultValue: "Copy",
                    })}
                  </button>
                  <button
                    type="button"
                    className="overlay-progress-button"
                    onClick={handleViewHistoryEntry}
                    disabled={overlayActionPending}
                  >
                    {i18n.t("overlay.fullSystemProgress.view", {
                      defaultValue: "View",
                    })}
                  </button>
                  <button
                    type="button"
                    className="overlay-progress-button overlay-progress-button-ghost"
                    onClick={handleDismissOverlay}
                    disabled={overlayActionPending}
                  >
                    {i18n.t("overlay.fullSystemProgress.exit", {
                      defaultValue: "Exit",
                    })}
                  </button>
                </div>
              )}
            </div>
            <p>{fullSystemProgress.subtitle}</p>
          </div>
          <div className="overlay-progress-meter">
            <div className="overlay-progress-meter-topline">
              <div className="overlay-progress-meter-label">
                {fullSystemProgress.progressLabel}
              </div>
              <div className="overlay-progress-meter-value">
                {progressPercent}%
              </div>
            </div>
            <div className="overlay-progress-track" aria-hidden>
              <div
                className="overlay-progress-fill"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
          <div className="overlay-progress-footer">
            <span className="overlay-progress-pulse" aria-hidden />
            <span>{fullSystemProgress.footerNote}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      dir={direction}
      className={`recording-overlay ${isVisible ? "fade-in" : ""}`}
    >
      <div
        className={`overlay-middle ${isRecordingState ? "overlay-middle-full" : "overlay-split"}`}
      >
        <div
          ref={waveContainerRef}
          className={`siriwave-host ${isProcessingState ? "siriwave-host-processing" : ""} ${
            shouldShowOverlayAlert || shouldShowWarmingPane
              ? "siriwave-host-hidden"
              : ""
          }`}
          role="presentation"
          aria-hidden
        />
        {shouldShowWarmingPane && (
          <div className="overlay-status-pane" role="status" aria-live="polite">
            <div className="overlay-status-title">{warmingTitle}</div>
          </div>
        )}
        {shouldShowOverlayAlert && (
          <div
            className={`overlay-alert-pane ${overlayAlertClassName}`}
            role="status"
            aria-live="polite"
          >
            <div className="overlay-alert-title">{overlayAlertTitle}</div>
            <div className="overlay-alert-description">
              {overlayAlertDescription}
            </div>
          </div>
        )}
        {isProcessingState && !shouldShowOverlayAlert && (
          <div className="overlay-spinner-pane" aria-hidden>
            <div className="overlay-spinner" />
          </div>
        )}
      </div>
    </div>
  );
};

export default RecordingOverlay;

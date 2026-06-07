import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import React, { useEffect, useRef, useState } from "react";
import "./RecordingOverlay.css";
import i18n, { syncLanguageFromSettings } from "@/i18n";
import { getLanguageDirection } from "@/lib/utils/rtl";
import SiriWave from "siriwave";

type OverlayState =
  | "warming"
  | "recording"
  | "trial_ended"
  | "transcribing"
  | "processing";
type OverlayAlertKind = "no_input" | "trial_ended";

const INPUT_ATTACK_SMOOTHING_KEEP = 0.18;
const INPUT_ATTACK_SMOOTHING_NEW = 0.82;
const INPUT_RELEASE_SMOOTHING_KEEP = 0.46;
const INPUT_RELEASE_SMOOTHING_NEW = 0.54;
const WAVE_ENERGY_POWER = 0.56;
const QUIET_SPEECH_GAIN = 2.2;
const QUIET_FLOOR = 0.12;
const SILENCE_ACTIVITY_START = 0.0025;
const SILENCE_ACTIVITY_RANGE = 0.012;
const SILENCE_LEVEL_GATE = 0.0025;
const SPEECH_WAKE_AVERAGE = 0.00055;
const SPEECH_WAKE_PEAK = 0.0035;
const SPEECH_SLEEP_AVERAGE = 0.00024;
const SPEECH_SLEEP_PEAK = 0.0012;
const SPEECH_SLEEP_HOLD_MS = 260;
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
const SUSTAINED_SPEECH_ENERGY_DECAY = 0.9;
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

const startOverlayDrag = (event: React.MouseEvent<HTMLDivElement>) => {
  if (event.button !== 0) {
    return;
  }

  void getCurrentWindow()
    .startDragging()
    .catch((error) => {
      console.warn("Recording overlay drag failed:", error);
    });
};

const useRecordingOverlayController = () => {
  const [isVisible, setIsVisible] = useState(true);
  const [state, setState] = useState<OverlayState>("recording");
  const [overlayAlert, setOverlayAlert] = useState<OverlayAlertKind | null>(
    null,
  );
  const waveContainerRef = useRef<HTMLDivElement | null>(null);
  const siriWaveRef = useRef<SiriWave | null>(null);
  const waveMetricsRef = useRef({ width: 0, height: 0, ratio: 1 });
  const smoothedLevelsRef = useRef<number[] | null>(null);
  if (smoothedLevelsRef.current === null) {
    smoothedLevelsRef.current = Array(16).fill(0);
  }
  const lastSpeechEnergyRef = useRef(0);
  const overlayStateRef = useRef<OverlayState>("recording");
  const overlayAlertRef = useRef<OverlayAlertKind | null>(null);
  const hasDetectedSpeechRef = useRef(false);
  const quietSinceRef = useRef<number | null>(null);
  const isVisibleRef = useRef(true);
  const lastHideAtRef = useRef(0);
  const previousStateRef = useRef<OverlayState>("recording");
  const direction = getLanguageDirection(i18n.language);
  const isRecordingState = state === "recording";
  const isWarmingState = state === "warming";
  const isProcessingState = state === "transcribing" || state === "processing";
  const shouldShowOverlayAlert = overlayAlert !== null;
  const shouldShowWarmingPane = isWarmingState && !shouldShowOverlayAlert;

  const setOverlayVisibility = (visible: boolean) => {
    isVisibleRef.current = visible;
    setIsVisible(visible);
  };

  const setSpeechDetectedRef = (detected: boolean) => {
    hasDetectedSpeechRef.current = detected;
  };

  const resetSpeechTracking = () => {
    quietSinceRef.current = null;
    lastSpeechEnergyRef.current = 0;
    setSpeechDetectedRef(false);
  };

  const setOverlayMode = (nextState: OverlayState) => {
    overlayStateRef.current = nextState;
    setState(nextState);
    if (nextState !== "recording") {
      resetSpeechTracking();
    }
  };

  const setAlertKind = (nextAlert: OverlayAlertKind | null) => {
    overlayAlertRef.current = nextAlert;
    setOverlayAlert(nextAlert);
    if (nextAlert !== null) {
      setOverlayVisibility(true);
    }
  };

  const disposeSiriWave = () => {
    siriWaveRef.current?.dispose();
    siriWaveRef.current = null;
  };

  const getSmoothedLevels = () => {
    if (smoothedLevelsRef.current === null) {
      smoothedLevelsRef.current = Array(16).fill(0);
    }

    return smoothedLevelsRef.current;
  };

  const createSiriWave = () => {
    const host = waveContainerRef.current;
    const { width, height, ratio } = waveMetricsRef.current;
    if (!host || width <= 0 || height <= 0 || !isVisibleRef.current) {
      return null;
    }

    disposeSiriWave();
    siriWaveRef.current = new SiriWave({
      container: host,
      style: "ios9",
      ratio,
      width,
      height,
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

    return siriWaveRef.current;
  };

  const getCurrentWaveEnergy = () => {
    const levels = getSmoothedLevels();
    const averageLevel =
      levels.reduce((sum, level) => sum + level, 0) / levels.length;
    const peakLevel = Math.max(...levels, 0);
    const waveEnergy = clamp(
      Math.pow(averageLevel, WAVE_ENERGY_POWER) * QUIET_SPEECH_GAIN +
        QUIET_FLOOR,
      WAVE_ENERGY_MIN,
      WAVE_ENERGY_MAX,
    );

    if (!hasDetectedSpeechRef.current) {
      return waveEnergy;
    }

    return Math.min(
      Math.max(waveEnergy, lastSpeechEnergyRef.current),
      EFFECTIVE_WAVE_ENERGY_CAP,
    );
  };

  const syncSiriWaveForOverlay = () => {
    if (!isVisibleRef.current) {
      disposeSiriWave();
      return;
    }

    const siriWave = siriWaveRef.current ?? createSiriWave();
    if (!siriWave) {
      return;
    }

    const currentState = overlayStateRef.current;
    const hasAlert = overlayAlertRef.current !== null;
    const isProcessing =
      currentState === "transcribing" || currentState === "processing";

    if (isProcessing || hasAlert) {
      if (previousStateRef.current === "recording" && siriWave.run) {
        siriWave.stop();
      }
      previousStateRef.current = currentState;
      return;
    }

    if (currentState !== "recording") {
      if (siriWave.run) {
        siriWave.stop();
      }
      siriWave.setAmplitude(WAVE_AMPLITUDE_MIN * 0.45);
      siriWave.setSpeed(WAVE_SPEED_MIN * 0.5);
      previousStateRef.current = currentState;
      return;
    }

    if (!siriWave.run) {
      siriWave.start();
    }

    const effectiveWaveEnergy = getCurrentWaveEnergy();
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
    const amplitude = hasDetectedSpeechRef.current
      ? activeAmplitude
      : WAVE_IDLE_AMPLITUDE;
    const speed = hasDetectedSpeechRef.current ? activeSpeed : WAVE_IDLE_SPEED;
    siriWave.setAmplitude(amplitude);
    siriWave.setSpeed(speed);
    previousStateRef.current = currentState;
  };

  useEffect(() => {
    let isDisposed = false;
    const unlistenFns: Array<() => void> = [];

    const setupEventListeners = async () => {
      const [unlistenShow, unlistenHide, unlistenAlert, unlistenLevel] =
        await Promise.all([
          listen("show-overlay", async (event) => {
            const overlayState = event.payload as OverlayState;
            setOverlayVisibility(true);
            setOverlayMode(overlayState);
            smoothedLevelsRef.current = Array(16).fill(0);
            setAlertKind(overlayState === "trial_ended" ? "trial_ended" : null);
            resetSpeechTracking();
            syncSiriWaveForOverlay();

            // Sync language from settings without blocking the overlay from
            // becoming visible on the hotkey path.
            void syncLanguageFromSettings();
          }),
          listen("hide-overlay", () => {
            lastHideAtRef.current = Date.now();
            setAlertKind(null);
            resetSpeechTracking();
            setOverlayVisibility(false);
            syncSiriWaveForOverlay();
          }),
          listen<OverlayAlertKind>("overlay-alert", (event) => {
            setAlertKind(event.payload);
            syncSiriWaveForOverlay();
          }),
          listen<number[]>("mic-level", (event) => {
            const newLevels = event.payload as number[];
            // Fallback only when hidden: if this webview missed `show-overlay`,
            // level activity implies active recording.
            if (!isVisibleRef.current) {
              // Ignore delayed mic-level events that often arrive right after hide
              // to prevent a one-frame recording-wave flash at the end.
              if (Date.now() - lastHideAtRef.current < 450) {
                return;
              }
              setOverlayVisibility(true);
              setOverlayMode("recording");
              syncSiriWaveForOverlay();
            }

            const previousLevels = getSmoothedLevels();
            // Apply smoothing to reduce jitter
            const smoothed = previousLevels.map((prev, i) => {
              const target = newLevels[i] || 0;
              if (
                target < SILENCE_LEVEL_GATE &&
                prev < SILENCE_LEVEL_GATE * 1.5
              ) {
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

            if (overlayStateRef.current !== "recording") {
              quietSinceRef.current = null;
              syncSiriWaveForOverlay();
              return;
            }

            const rawAverage =
              newLevels.reduce((sum, level) => sum + level, 0) /
              newLevels.length;
            const rawPeak = Math.max(...newLevels, 0);
            const rawEnergy = clamp(
              Math.pow(
                Math.max(rawAverage, rawPeak * 0.42),
                WAVE_ENERGY_POWER,
              ) *
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
                setSpeechDetectedRef(true);
                syncSiriWaveForOverlay();
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
                setSpeechDetectedRef(false);
                syncSiriWaveForOverlay();
              }
              return;
            }

            lastSpeechEnergyRef.current = Math.max(
              lastSpeechEnergyRef.current * SUSTAINED_SPEECH_ENERGY_DECAY,
              rawEnergy,
              SUSTAINED_SPEECH_MIN_ENERGY,
            );
            quietSinceRef.current = null;
            syncSiriWaveForOverlay();
          }),
        ]);

      if (isDisposed) {
        unlistenShow();
        unlistenHide();
        unlistenAlert();
        unlistenLevel();
        return;
      }

      unlistenFns.push(
        unlistenShow,
        unlistenHide,
        unlistenAlert,
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

      const current = waveMetricsRef.current;
      const changed =
        current.width !== nextWidth ||
        current.height !== nextHeight ||
        Math.abs(current.ratio - nextDpr) > 0.001;
      if (!changed) {
        return;
      }

      waveMetricsRef.current = {
        width: nextWidth,
        height: nextHeight,
        ratio: nextDpr,
      };
      if (isVisibleRef.current) {
        createSiriWave();
        syncSiriWaveForOverlay();
      }
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
      disposeSiriWave();
    };
  }, []);

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

  return {
    direction,
    isVisible,
    isRecordingState,
    isProcessingState,
    shouldShowOverlayAlert,
    shouldShowWarmingPane,
    waveContainerRef,
    overlayAlertTitle,
    overlayAlertDescription,
    overlayAlertClassName,
    warmingTitle,
  };
};

const RecordingOverlay: React.FC = () => {
  const {
    direction,
    isVisible,
    isRecordingState,
    isProcessingState,
    shouldShowOverlayAlert,
    shouldShowWarmingPane,
    waveContainerRef,
    overlayAlertTitle,
    overlayAlertDescription,
    overlayAlertClassName,
    warmingTitle,
  } = useRecordingOverlayController();

  return (
    <div
      dir={direction}
      className={`recording-overlay ${isVisible ? "fade-in" : ""}`}
      data-tauri-drag-region
      role="presentation"
      onMouseDown={startOverlayDrag}
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
          aria-hidden
        />
        {shouldShowWarmingPane && (
          <output className="overlay-status-pane" aria-live="polite">
            <div className="overlay-status-title">{warmingTitle}</div>
          </output>
        )}
        {shouldShowOverlayAlert && (
          <output
            className={`overlay-alert-pane ${overlayAlertClassName}`}
            aria-live="polite"
          >
            <div className="overlay-alert-title">{overlayAlertTitle}</div>
            <div className="overlay-alert-description">
              {overlayAlertDescription}
            </div>
          </output>
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

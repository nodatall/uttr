import { listen } from "@tauri-apps/api/event";
import React, { useEffect, useMemo, useRef, useState } from "react";
import "./RecordingOverlay.css";
import i18n, { syncLanguageFromSettings } from "@/i18n";
import { getLanguageDirection } from "@/lib/utils/rtl";
import SiriWave from "siriwave";

type OverlayState = "warming" | "recording" | "transcribing" | "processing";
type OverlayAlertKind = "no_input";

const INPUT_ATTACK_SMOOTHING_KEEP = 0.18;
const INPUT_ATTACK_SMOOTHING_NEW = 0.82;
const INPUT_RELEASE_SMOOTHING_KEEP = 0.74;
const INPUT_RELEASE_SMOOTHING_NEW = 0.26;
const WAVE_ENERGY_POWER = 0.72;
const QUIET_SPEECH_GAIN = 2.85;
const QUIET_FLOOR = 0.12;
const SILENCE_ACTIVITY_START = 0.0025;
const SILENCE_ACTIVITY_RANGE = 0.012;
const SPEECH_WAKE_THRESHOLD = 0.42;
const WAVE_ENERGY_MIN = 0;
const WAVE_ENERGY_MAX = 1;
const WAVE_AMPLITUDE_MIN = 0.9;
const WAVE_AMPLITUDE_RANGE = 3.1;
const WAVE_AMPLITUDE_CAP = 4.4;
const WAVE_AMPLITUDE_BOOST = 1.5625;
const WAVE_MAX_AMPLITUDE_FACTOR = 0.5625;
const WAVE_PEAK_GUARD = 0.72;
const WAVE_SPEED_MIN = 0.1;
const WAVE_SPEED_RANGE = 0.16;
const WAVE_SPEED_CAP = 0.26;
const WAVE_IDLE_AMPLITUDE = 0.58;
const WAVE_IDLE_SPEED = 0.055;
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
  const waveContainerRef = useRef<HTMLDivElement | null>(null);
  const siriWaveRef = useRef<SiriWave | null>(null);
  const smoothedLevelsRef = useRef<number[]>(Array(16).fill(0));
  const hasDetectedSpeechRef = useRef(false);
  const isVisibleRef = useRef(true);
  const lastHideAtRef = useRef(0);
  const previousStateRef = useRef<OverlayState>("recording");
  const direction = getLanguageDirection(i18n.language);
  const isRecordingState = state === "recording";
  const isWarmingState = state === "warming";
  const isProcessingState = state === "transcribing" || state === "processing";
  const shouldShowOverlayAlert = overlayAlert !== null;
  const shouldShowWarmingPane = isWarmingState && !shouldShowOverlayAlert;

  useEffect(() => {
    isVisibleRef.current = isVisible;
  }, [isVisible]);

  useEffect(() => {
    hasDetectedSpeechRef.current = hasDetectedSpeech;
  }, [hasDetectedSpeech]);

  useEffect(() => {
    let isDisposed = false;
    const unlistenFns: Array<() => void> = [];

    const setupEventListeners = async () => {
      // Listen for show-overlay event from Rust
      const unlistenShow = await listen("show-overlay", async (event) => {
        // Sync language from settings each time overlay is shown
        await syncLanguageFromSettings();
        const overlayState = event.payload as OverlayState;
        isVisibleRef.current = true;
        setState(overlayState);
        smoothedLevelsRef.current = Array(16).fill(0);
        setLevels(Array(16).fill(0));
        setOverlayAlert(null);
        setHasDetectedSpeech(false);
        setIsVisible(true);
      });

      // Listen for hide-overlay event from Rust
      const unlistenHide = await listen("hide-overlay", () => {
        isVisibleRef.current = false;
        lastHideAtRef.current = Date.now();
        setOverlayAlert(null);
        setHasDetectedSpeech(false);
        setIsVisible(false);
      });

      const unlistenAlert = await listen<OverlayAlertKind>(
        "overlay-alert",
        (event) => {
          setOverlayAlert(event.payload);
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
          if (target > prev) {
            if (prev < 0.015 && target > 0.05) {
              return target;
            }

            return (
              prev * INPUT_ATTACK_SMOOTHING_KEEP +
              target * INPUT_ATTACK_SMOOTHING_NEW
            );
          }

          return (
            prev * INPUT_RELEASE_SMOOTHING_KEEP +
            target * INPUT_RELEASE_SMOOTHING_NEW
          );
        });

        smoothedLevelsRef.current = smoothed;
        setLevels(smoothed);

      });

      if (isDisposed) {
        unlistenShow();
        unlistenHide();
        unlistenAlert();
        unlistenLevel();
        return;
      }

      unlistenFns.push(unlistenShow, unlistenHide, unlistenAlert, unlistenLevel);
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
  }, [
    isVisible,
    waveHostWidth,
    waveHostHeight,
    devicePixelRatio,
  ]);

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
    if (!showWave || hasDetectedSpeechRef.current) {
      return;
    }

    if (waveMotionBlend >= SPEECH_WAKE_THRESHOLD) {
      setHasDetectedSpeech(true);
    }
  }, [showWave, waveMotionBlend]);

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
      (WAVE_AMPLITUDE_MIN + waveEnergy * WAVE_AMPLITUDE_RANGE) *
        WAVE_AMPLITUDE_BOOST,
      WAVE_AMPLITUDE_MIN,
      WAVE_AMPLITUDE_CAP *
        WAVE_AMPLITUDE_BOOST *
        WAVE_MAX_AMPLITUDE_FACTOR *
        WAVE_PEAK_GUARD,
    );
    const activeSpeed = clamp(
      WAVE_SPEED_MIN + waveEnergy * WAVE_SPEED_RANGE,
      WAVE_SPEED_MIN,
      WAVE_SPEED_CAP,
    );
    const amplitude = hasDetectedSpeech
      ? activeAmplitude
      : lerp(WAVE_IDLE_AMPLITUDE, activeAmplitude, waveMotionBlend);
    const speed = hasDetectedSpeech
      ? activeSpeed
      : lerp(WAVE_IDLE_SPEED, activeSpeed, waveMotionBlend);
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
    waveEnergy,
  ]);

  const noInputTitle =
    overlayAlert === "no_input"
      ? i18n.t("overlay.noInputTitle", {
          defaultValue: "No input detected",
        })
      : "";
  const noInputDescription =
    overlayAlert === "no_input"
      ? i18n.t("overlay.noInputDescription", {
          defaultValue: "Check your microphone settings.",
        })
      : "";
  const overlayAlertClassName =
    overlayAlert === "no_input" ? "overlay-alert-pane-warning" : "";
  const warmingTitle = i18n.t("overlay.warmingMic", {
    defaultValue: "Warming mic...",
  });

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
            <div className="overlay-alert-title">{noInputTitle}</div>
            <div className="overlay-alert-description">
              {noInputDescription}
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

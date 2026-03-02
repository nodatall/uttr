import { listen } from "@tauri-apps/api/event";
import React, { useEffect, useMemo, useRef, useState } from "react";
import "./RecordingOverlay.css";
import i18n, { syncLanguageFromSettings } from "@/i18n";
import { getLanguageDirection } from "@/lib/utils/rtl";
import SiriWave from "siriwave";

type OverlayState = "recording" | "transcribing" | "processing";

const INPUT_SMOOTHING_KEEP = 0.58;
const INPUT_SMOOTHING_NEW = 0.42;
const WAVE_ENERGY_POWER = 0.72;
const QUIET_SPEECH_GAIN = 2.85;
const QUIET_FLOOR = 0.12;
const WAVE_ENERGY_MIN = 0;
const WAVE_ENERGY_MAX = 1;
const WAVE_AMPLITUDE_MIN = 0.9;
const WAVE_AMPLITUDE_RANGE = 3.1;
const WAVE_AMPLITUDE_CAP = 4.4;
const WAVE_AMPLITUDE_BOOST = 1.5625;
const WAVE_MAX_AMPLITUDE_FACTOR = 0.75;
const WAVE_SPEED_MIN = 0.1;
const WAVE_SPEED_RANGE = 0.24;
const WAVE_SPEED_CAP = 0.36;
const IOS9_BASELINE_OFFSET_PX = 6;
const RECORDING_CURVES = [
  { color: "255,255,255", supportLine: true },
  { color: "102,217,255" },
  { color: "170,120,255" },
  { color: "96,243,191" },
];
const TRANSCRIBING_CURVES = [
  { color: "255,214,198", supportLine: true },
  { color: "255,73,50" },
  { color: "255,116,38" },
  { color: "255,176,64" },
];

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const RecordingOverlay: React.FC = () => {
  const [waveHostWidth, setWaveHostWidth] = useState(0);
  const [waveHostHeight, setWaveHostHeight] = useState(0);
  const [devicePixelRatio, setDevicePixelRatio] = useState(
    window.devicePixelRatio || 1,
  );
  const [isVisible, setIsVisible] = useState(true);
  const [state, setState] = useState<OverlayState>("recording");
  const [levels, setLevels] = useState<number[]>(Array(16).fill(0));
  const waveContainerRef = useRef<HTMLDivElement | null>(null);
  const siriWaveRef = useRef<SiriWave | null>(null);
  const smoothedLevelsRef = useRef<number[]>(Array(16).fill(0));
  const direction = getLanguageDirection(i18n.language);
  const showWave =
    state === "recording" || state === "transcribing" || state === "processing";
  const isOrangeState = state === "transcribing" || state === "processing";

  useEffect(() => {
    let isDisposed = false;
    const unlistenFns: Array<() => void> = [];

    const setupEventListeners = async () => {
      // Listen for show-overlay event from Rust
      const unlistenShow = await listen("show-overlay", async (event) => {
        // Sync language from settings each time overlay is shown
        await syncLanguageFromSettings();
        const overlayState = event.payload as OverlayState;
        setState(overlayState);
        setIsVisible(true);
      });

      // Listen for hide-overlay event from Rust
      const unlistenHide = await listen("hide-overlay", () => {
        setIsVisible(false);
      });

      // Listen for mic-level updates
      const unlistenLevel = await listen<number[]>("mic-level", (event) => {
        const newLevels = event.payload as number[];
        // Fallback: if this hidden webview missed `show-overlay`, levels imply active recording.
        setIsVisible(true);

        // Apply smoothing to reduce jitter
        const smoothed = smoothedLevelsRef.current.map((prev, i) => {
          const target = newLevels[i] || 0;
          return prev * INPUT_SMOOTHING_KEEP + target * INPUT_SMOOTHING_NEW;
        });

        smoothedLevelsRef.current = smoothed;
        setLevels(smoothed);
      });

      if (isDisposed) {
        unlistenShow();
        unlistenHide();
        unlistenLevel();
        return;
      }

      unlistenFns.push(unlistenShow, unlistenHide, unlistenLevel);
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
      const yShift = IOS9_BASELINE_OFFSET_PX / nextDpr;
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
    if (!host || !isVisible || !showWave) {
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
      curveDefinition: isOrangeState ? TRANSCRIBING_CURVES : RECORDING_CURVES,
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
    showWave,
    isOrangeState,
    waveHostWidth,
    waveHostHeight,
    devicePixelRatio,
  ]);

  const waveEnergy = useMemo(() => {
    const average = levels.reduce((sum, level) => sum + level, 0) / levels.length;
    const boosted = Math.pow(average, WAVE_ENERGY_POWER) * QUIET_SPEECH_GAIN + QUIET_FLOOR;
    return clamp(boosted, WAVE_ENERGY_MIN, WAVE_ENERGY_MAX);
  }, [levels]);

  useEffect(() => {
    if (!isVisible || !showWave) {
      return;
    }

    const siriWave = siriWaveRef.current;
    if (!siriWave) {
      return;
    }

    const amplitude = clamp(
      (WAVE_AMPLITUDE_MIN + waveEnergy * WAVE_AMPLITUDE_RANGE) *
        WAVE_AMPLITUDE_BOOST,
      WAVE_AMPLITUDE_MIN,
      WAVE_AMPLITUDE_CAP * WAVE_AMPLITUDE_BOOST * WAVE_MAX_AMPLITUDE_FACTOR,
    );
    const speed = clamp(
      WAVE_SPEED_MIN + waveEnergy * WAVE_SPEED_RANGE,
      WAVE_SPEED_MIN,
      WAVE_SPEED_CAP,
    );

    if (isOrangeState) {
      const orangeAmplitude = clamp(
        amplitude * 1.22,
        WAVE_AMPLITUDE_MIN * 1.05,
        WAVE_AMPLITUDE_CAP,
      );
      const orangeSpeed = clamp(speed * 0.22, 0.02, 0.085);
      siriWave.setAmplitude(orangeAmplitude);
      siriWave.setSpeed(orangeSpeed);
    } else {
      siriWave.setAmplitude(amplitude);
      siriWave.setSpeed(speed);
    }
  }, [isVisible, showWave, waveEnergy, isOrangeState]);

  return (
    <div
      dir={direction}
      className={`recording-overlay ${isOrangeState ? "overlay-state-busy" : ""} ${
        isVisible ? "fade-in" : ""
      }`}
    >
      <div className="overlay-middle overlay-middle-full">
        {showWave && (
          <div ref={waveContainerRef} className="siriwave-host" role="presentation" aria-hidden />
        )}
      </div>
    </div>
  );
};

export default RecordingOverlay;

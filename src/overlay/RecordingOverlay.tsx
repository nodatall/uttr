import { listen } from "@tauri-apps/api/event";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
const WAVE_SPEED_MIN = 0.1;
const WAVE_SPEED_RANGE = 0.24;
const WAVE_SPEED_CAP = 0.36;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const RecordingOverlay: React.FC = () => {
  const { t } = useTranslation();
  const [isVisible, setIsVisible] = useState(true);
  const [state, setState] = useState<OverlayState>("recording");
  const [levels, setLevels] = useState<number[]>(Array(16).fill(0));
  const waveContainerRef = useRef<HTMLDivElement | null>(null);
  const siriWaveRef = useRef<SiriWave | null>(null);
  const smoothedLevelsRef = useRef<number[]>(Array(16).fill(0));
  const direction = getLanguageDirection(i18n.language);

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
    if (!host || !isVisible || state !== "recording") {
      siriWaveRef.current?.dispose();
      siriWaveRef.current = null;
      return undefined;
    }

    siriWaveRef.current?.dispose();
    siriWaveRef.current = new SiriWave({
      container: host,
      style: "ios9",
      width: host.clientWidth,
      height: host.clientHeight,
      autostart: true,
      amplitude: WAVE_AMPLITUDE_MIN,
      speed: WAVE_SPEED_MIN,
      pixelDepth: 0.02,
      lerpSpeed: 0.11,
      globalCompositeOperation: "lighter",
      curveDefinition: [
        { color: "255,255,255", supportLine: true },
        { color: "102,217,255" },
        { color: "170,120,255" },
        { color: "96,243,191" },
      ],
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
  }, [isVisible, state]);

  const waveEnergy = useMemo(() => {
    const average = levels.reduce((sum, level) => sum + level, 0) / levels.length;
    const boosted = Math.pow(average, WAVE_ENERGY_POWER) * QUIET_SPEECH_GAIN + QUIET_FLOOR;
    return clamp(boosted, WAVE_ENERGY_MIN, WAVE_ENERGY_MAX);
  }, [levels]);

  useEffect(() => {
    if (!isVisible || state !== "recording") {
      return;
    }

    const siriWave = siriWaveRef.current;
    if (!siriWave) {
      return;
    }

    const amplitude = clamp(
      WAVE_AMPLITUDE_MIN + waveEnergy * WAVE_AMPLITUDE_RANGE,
      WAVE_AMPLITUDE_MIN,
      WAVE_AMPLITUDE_CAP,
    );
    const speed = clamp(
      WAVE_SPEED_MIN + waveEnergy * WAVE_SPEED_RANGE,
      WAVE_SPEED_MIN,
      WAVE_SPEED_CAP,
    );

    siriWave.setAmplitude(amplitude);
    siriWave.setSpeed(speed);
  }, [isVisible, state, waveEnergy]);

  return (
    <div
      dir={direction}
      className={`recording-overlay ${isVisible ? "fade-in" : ""}`}
    >
      <div className="overlay-middle overlay-middle-full">
        {state === "recording" && (
          <div ref={waveContainerRef} className="siriwave-host" role="presentation" aria-hidden />
        )}
        {(state === "transcribing" || state === "processing") && (
          <div className="transcribing-text">{t("overlay.transcribing")}</div>
        )}
      </div>
    </div>
  );
};

export default RecordingOverlay;

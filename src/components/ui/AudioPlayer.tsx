import React, { useReducer, useRef, useEffect, useCallback } from "react";
import { Play, Pause } from "lucide-react";

interface AudioPlayerProps {
  /** Audio source URL. If not provided, onLoadRequest must be provided. */
  src?: string;
  /** Called when play is clicked and no src is loaded yet. Should return the audio URL. */
  onLoadRequest?: () => Promise<string | null>;
  className?: string;
  autoPlay?: boolean;
}

const formatTime = (time: number): string => {
  if (!isFinite(time)) return "0:00";

  const minutes = Math.floor(time / 60);
  const seconds = Math.floor(time % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const PASSIVE_LISTENER_OPTIONS: AddEventListenerOptions = { passive: true };

interface AudioPlayerState {
  isPlaying: boolean;
  duration: number;
  currentTime: number;
  loadedSrc: string | null;
  isLoading: boolean;
}

type AudioPlayerAction =
  | { type: "playing"; isPlaying: boolean }
  | { type: "duration"; duration: number; currentTime?: number }
  | { type: "current_time"; currentTime: number }
  | { type: "loaded_src"; loadedSrc: string | null }
  | { type: "loading"; isLoading: boolean };

const audioPlayerReducer = (
  state: AudioPlayerState,
  action: AudioPlayerAction,
): AudioPlayerState => {
  switch (action.type) {
    case "playing":
      return { ...state, isPlaying: action.isPlaying };
    case "duration":
      return {
        ...state,
        duration: action.duration,
        currentTime: action.currentTime ?? state.currentTime,
      };
    case "current_time":
      return { ...state, currentTime: action.currentTime };
    case "loaded_src":
      return { ...state, loadedSrc: action.loadedSrc };
    case "loading":
      return { ...state, isLoading: action.isLoading };
  }
};

export const AudioPlayer: React.FC<AudioPlayerProps> = ({
  src: initialSrc,
  onLoadRequest,
  className = "",
  autoPlay = false,
}) => {
  const [{ isPlaying, duration, currentTime, loadedSrc, isLoading }, dispatch] =
    useReducer(audioPlayerReducer, {
      isPlaying: false,
      duration: 0,
      currentTime: 0,
      loadedSrc: initialSrc ?? null,
      isLoading: false,
    });

  const audioRef = useRef<HTMLAudioElement>(null);
  const src = loadedSrc;
  const animationRef = useRef<number>();
  const dragTimeRef = useRef<number>(0);
  const handleMouseUpRef = useRef<() => void>(() => {});

  // Use refs to avoid stale closures in animation loop
  const isPlayingRef = useRef(false);
  const isDraggingRef = useRef(false);

  // Keep refs in sync with state
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  // Stable animation loop with no dependencies
  const tick = useCallback(() => {
    if (audioRef.current && !isDraggingRef.current) {
      const time = audioRef.current.currentTime;
      dispatch({ type: "current_time", currentTime: time });
    }

    if (isPlayingRef.current) {
      animationRef.current = requestAnimationFrame(tick);
    }
  }, []); // Empty dependency array is key!

  // Manage animation loop lifecycle
  useEffect(() => {
    if (isPlaying && !isDraggingRef.current) {
      // Only start if not already running
      if (!animationRef.current) {
        animationRef.current = requestAnimationFrame(tick);
      }
    } else {
      // Stop animation loop
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = undefined;
      }
    }

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = undefined;
      }
    };
  }, [isPlaying, tick]);

  // Audio event handlers
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleLoadedMetadata = () => {
      dispatch({
        type: "duration",
        duration: audio.duration || 0,
        currentTime: 0,
      });
    };

    const handleEnded = () => {
      dispatch({ type: "playing", isPlaying: false });
      dispatch({
        type: "current_time",
        currentTime: audio.duration || 0,
      });
    };

    const handlePlay = () => dispatch({ type: "playing", isPlaying: true });
    const handlePause = () => dispatch({ type: "playing", isPlaying: false });

    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);

    return () => {
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
    };
  }, []);

  // Global drag handlers
  handleMouseUpRef.current = () => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      if (audioRef.current) {
        audioRef.current.currentTime = dragTimeRef.current;
        dispatch({
          type: "current_time",
          currentTime: dragTimeRef.current,
        });
      }

      if (isPlayingRef.current && !animationRef.current) {
        animationRef.current = requestAnimationFrame(tick);
      }
    }
  };

  useEffect(() => {
    const handleMouseUp = () => handleMouseUpRef.current();

    document.addEventListener("mouseup", handleMouseUp);
    document.addEventListener(
      "touchend",
      handleMouseUp,
      PASSIVE_LISTENER_OPTIONS,
    );

    return () => {
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener(
        "touchend",
        handleMouseUp,
        PASSIVE_LISTENER_OPTIONS,
      );
    };
  }, []);

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      if (loadedSrc?.startsWith("blob:")) {
        URL.revokeObjectURL(loadedSrc);
      }
    };
  }, [loadedSrc]);

  const togglePlay = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isLoading) return;

    try {
      if (isPlaying) {
        audio.pause();
      } else {
        // If no src loaded yet, request it
        if (!src && onLoadRequest) {
          dispatch({ type: "loading", isLoading: true });
          const newSrc = await onLoadRequest();
          dispatch({ type: "loading", isLoading: false });
          if (newSrc) {
            audio.src = newSrc;
            dispatch({ type: "loaded_src", loadedSrc: newSrc });
            await audio.play();
          }
        } else if (src) {
          await audio.play();
        }
      }
    } catch (error) {
      console.error("Playback failed:", error);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTime = parseFloat(e.target.value);
    dragTimeRef.current = newTime;
    dispatch({ type: "current_time", currentTime: newTime });

    if (!isDraggingRef.current && audioRef.current) {
      audioRef.current.currentTime = newTime;
    }
  };

  const handleSliderMouseDown = () => {
    isDraggingRef.current = true;
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = undefined;
    }
  };

  const handleSliderTouchStart = () => {
    isDraggingRef.current = true;
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = undefined;
    }
  };

  // Fix playhead positioning with better edge case handling
  const getProgressPercent = (): number => {
    if (duration <= 0) return 0;

    // Handle the end case - if we're within 0.1 seconds of the end, show 100%
    if (duration - currentTime < 0.1) return 100;

    const percent = (currentTime / duration) * 100;
    return Math.min(100, Math.max(0, percent));
  };

  const progressPercent = getProgressPercent();

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <audio
        ref={audioRef}
        src={src ?? undefined}
        preload="metadata"
        autoPlay={autoPlay}
        aria-label="Audio preview"
      >
        <track
          kind="captions"
          src="data:text/vtt,WEBVTT%0A"
          label="Captions unavailable"
        />
      </audio>

      <button
        type="button"
        onClick={togglePlay}
        disabled={isLoading}
        className="cursor-pointer rounded-full border border-white/8 bg-white/[0.04] p-2 text-text/72 transition-colors hover:text-text disabled:opacity-50"
        aria-label={isPlaying ? "Pause" : "Play"}
      >
        {isPlaying ? (
          <Pause width={18} height={18} fill="currentColor" />
        ) : (
          <Play width={18} height={18} fill="currentColor" />
        )}
      </button>

      <div className="flex-1 flex items-center gap-2">
        <span className="min-w-[30px] text-xs tabular-nums text-text/44">
          {formatTime(currentTime)}
        </span>

        <input
          type="range"
          aria-label="Audio playback position"
          min="0"
          max={duration || 0}
          step="0.01"
          value={currentTime}
          onChange={handleSeek}
          onMouseDown={handleSliderMouseDown}
          onTouchStart={handleSliderTouchStart}
          className={`flex-1 h-1.5 appearance-none rounded-lg cursor-pointer bg-white/[0.08] focus:outline-none focus:ring-1 focus:ring-logo-primary/30 ${progressPercent >= 99.5 ? "[&::-webkit-slider-thumb]:translate-x-0.5 [&::-moz-range-thumb]:translate-x-0.5" : ""}`}
          style={{
            background: `linear-gradient(to right, rgba(103,215,163,0.92) 0%, rgba(103,215,163,0.92) ${progressPercent}%, rgba(255,255,255,0.08) ${progressPercent}%, rgba(255,255,255,0.08) 100%)`,
          }}
        />

        <span className="min-w-[30px] text-xs tabular-nums text-text/44">
          {formatTime(duration)}
        </span>
      </div>
    </div>
  );
};

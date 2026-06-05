import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { RoseThreeLoader } from "@/components/shared";

type AskSelectionState = "loading" | "result" | "error";

type AskSelectionPayload = {
  state: AskSelectionState;
  text?: string | null;
  error?: string | null;
};

const DEFAULT_PAYLOAD: AskSelectionPayload = {
  state: "loading",
  text: null,
  error: null,
};

const payloadsMatch = (
  first: AskSelectionPayload,
  second: AskSelectionPayload,
) =>
  first.state === second.state &&
  (first.text ?? null) === (second.text ?? null) &&
  (first.error ?? null) === (second.error ?? null);

const closePanel = () => {
  void invoke("hide_ask_selection_panel").catch(() => {
    void getCurrentWindow().hide();
  });
};

const startPanelDrag = (event: MouseEvent<HTMLElement>) => {
  if (event.button !== 0) {
    return;
  }
  if ((event.target as HTMLElement).closest("button")) {
    return;
  }

  void getCurrentWindow()
    .startDragging()
    .catch((error) => {
      console.warn("Ask Selection drag failed:", error);
    });
};

export default function AskSelectionPanel() {
  const [payload, setPayload] = useState<AskSelectionPayload>(DEFAULT_PAYLOAD);
  const [copied, setCopied] = useState(false);
  const payloadRef = useRef<AskSelectionPayload>(DEFAULT_PAYLOAD);
  const copyResetRef = useRef<number | null>(null);

  const applyPayload = useCallback((nextPayload: AskSelectionPayload | null) => {
    const normalizedPayload = nextPayload ?? DEFAULT_PAYLOAD;
    if (payloadsMatch(payloadRef.current, normalizedPayload)) {
      return;
    }

    payloadRef.current = normalizedPayload;
    setPayload(normalizedPayload);
    setCopied(false);
  }, []);

  const refreshPayload = useCallback(() => {
    void invoke<AskSelectionPayload | null>("get_ask_selection_payload")
      .then((latestPayload) => {
        applyPayload(latestPayload);
      })
      .catch(() => {});
  }, [applyPayload]);

  useEffect(() => {
    const unlistenPromise = listen<AskSelectionPayload>(
      "ask-selection-state",
      (event) => {
        applyPayload(event.payload);
      },
    );

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closePanel();
      }
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        refreshPayload();
      }
    };

    refreshPayload();
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("focus", refreshPayload);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("focus", refreshPayload);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (copyResetRef.current !== null) {
        window.clearTimeout(copyResetRef.current);
      }
    };
  }, [applyPayload, refreshPayload]);

  useEffect(() => {
    if (payload.state !== "loading") {
      return;
    }

    const interval = window.setInterval(() => {
      refreshPayload();
    }, 500);

    return () => {
      window.clearInterval(interval);
    };
  }, [payload.state, refreshPayload]);

  const handleCopy = async () => {
    const text = payload.text?.trim();
    if (!text) {
      return;
    }

    try {
      await writeText(text);
      setCopied(true);
      if (copyResetRef.current !== null) {
        window.clearTimeout(copyResetRef.current);
      }
      copyResetRef.current = window.setTimeout(() => {
        setCopied(false);
      }, 1800);
    } catch (error) {
      console.error("Failed to copy Ask Selection result:", error);
    }
  };

  const statusText = copied ? "Copied" : "";
  const hasResult = payload.state === "result" && payload.text?.trim();
  const hasError = payload.state === "error";

  return (
    <div className="ask-selection-shell">
      <section
        className="ask-selection-panel"
        aria-label="Ask Selection result"
        data-tauri-drag-region
        onMouseDown={startPanelDrag}
      >
        <header
          className="ask-selection-header"
          data-tauri-drag-region
        >
          <span
            className={`ask-selection-status ${copied ? "ask-selection-status-visible" : ""}`}
            aria-live="polite"
          >
            {statusText}
          </span>
          <button
            type="button"
            className="ask-selection-close"
            aria-label="Close"
            onClick={closePanel}
          >
            <X aria-hidden="true" size={15} strokeWidth={2.2} />
          </button>
        </header>
        <div className="ask-selection-body">
          {payload.state === "loading" && (
            <div className="ask-selection-loading" role="status">
              <RoseThreeLoader
                className="ask-selection-loader"
                ariaLabel="Thinking"
              />
              <span>Thinking...</span>
            </div>
          )}
          {hasResult && (
            <button
              type="button"
              className="ask-selection-result"
              onClick={handleCopy}
            >
              {payload.text}
            </button>
          )}
          {hasError && (
            <p className="ask-selection-error">
              {payload.error?.trim() || "Ask Selection failed."}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

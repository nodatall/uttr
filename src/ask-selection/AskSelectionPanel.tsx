import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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

const closePanel = () => {
  void getCurrentWindow().hide();
};

export default function AskSelectionPanel() {
  const [payload, setPayload] = useState<AskSelectionPayload>(DEFAULT_PAYLOAD);
  const [copied, setCopied] = useState(false);
  const copyResetRef = useRef<number | null>(null);

  useEffect(() => {
    const unlistenPromise = listen<AskSelectionPayload>(
      "ask-selection-state",
      (event) => {
        setPayload(event.payload);
        setCopied(false);
      },
    );

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closePanel();
      }
    };
    const handleBlur = () => {
      closePanel();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("blur", handleBlur);

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("blur", handleBlur);
      if (copyResetRef.current !== null) {
        window.clearTimeout(copyResetRef.current);
      }
    };
  }, []);

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
      >
        <header className="ask-selection-header">
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

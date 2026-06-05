import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { RoseThreeLoader } from "@/components/shared";

type AskSelectionState = "recording" | "thinking" | "result" | "error";

type AskSelectionMessage = {
  role: "user" | "assistant" | string;
  text: string;
  pending: boolean;
};

type AskSelectionPayload = {
  state: AskSelectionState;
  text?: string | null;
  error?: string | null;
  sessionId?: number | null;
  messages?: AskSelectionMessage[] | null;
};

const DEFAULT_PAYLOAD: AskSelectionPayload = {
  state: "thinking",
  text: null,
  error: null,
  sessionId: null,
  messages: [],
};

const payloadsMatch = (
  first: AskSelectionPayload,
  second: AskSelectionPayload,
) =>
  first.state === second.state &&
  (first.text ?? null) === (second.text ?? null) &&
  (first.error ?? null) === (second.error ?? null) &&
  (first.sessionId ?? null) === (second.sessionId ?? null) &&
  JSON.stringify(first.messages ?? []) === JSON.stringify(second.messages ?? []);

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
  if ((event.target as HTMLElement).closest("textarea,input")) {
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
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const payloadRef = useRef<AskSelectionPayload>(DEFAULT_PAYLOAD);
  const copyResetRef = useRef<number | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);

  const applyPayload = useCallback((nextPayload: AskSelectionPayload | null) => {
    const normalizedPayload = {
      ...DEFAULT_PAYLOAD,
      ...(nextPayload ?? {}),
      messages: nextPayload?.messages ?? [],
    };
    if (payloadsMatch(payloadRef.current, normalizedPayload)) {
      return;
    }

    payloadRef.current = normalizedPayload;
    setPayload(normalizedPayload);
    setCopied(false);
    setIsSending(normalizedPayload.state === "thinking");
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

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
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
    if (payload.state !== "thinking" && payload.state !== "recording") {
      return;
    }

    const interval = window.setInterval(() => {
      refreshPayload();
    }, 500);

    return () => {
      window.clearInterval(interval);
    };
  }, [payload.state, refreshPayload]);

  useEffect(() => {
    messageListRef.current?.scrollTo({
      top: messageListRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [payload.messages?.length, payload.state]);

  const handleCopy = async (text: string | null | undefined) => {
    const cleanText = text?.trim();
    if (!cleanText) {
      return;
    }

    try {
      await writeText(cleanText);
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

  const sendFollowUp = useCallback(async () => {
    const message = draft.trim();
    const sessionId = payload.sessionId;
    if (!message || !sessionId || isSending) {
      return;
    }

    const optimisticMessages = [
      ...(payload.messages ?? []),
      { role: "user", text: message, pending: false },
      { role: "assistant", text: "Thinking...", pending: true },
    ];
    const optimisticPayload: AskSelectionPayload = {
      ...payload,
      state: "thinking",
      messages: optimisticMessages,
    };
    payloadRef.current = optimisticPayload;
    setPayload(optimisticPayload);
    setDraft("");
    setCopied(false);
    setIsSending(true);

    try {
      const nextPayload = await invoke<AskSelectionPayload>(
        "ask_selection_follow_up",
        {
          sessionId,
          message,
        },
      );
      applyPayload(nextPayload);
    } catch (error) {
      const errorPayload: AskSelectionPayload = {
        ...payloadRef.current,
        state: "error",
        error: String(error),
      };
      applyPayload(errorPayload);
    } finally {
      setIsSending(false);
    }
  }, [applyPayload, draft, isSending, payload]);

  const handleComposerKeyDown = (
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    event.preventDefault();
    void sendFollowUp();
  };

  const statusText = copied ? "Copied" : "";
  const messages = useMemo(() => payload.messages ?? [], [payload.messages]);
  const hasError = payload.state === "error";
  const hasMessages = messages.length > 0;
  const hasCompletedAssistantMessage = messages.some(
    (message) => message.role === "assistant" && !message.pending,
  );
  const canChat =
    Boolean(payload.sessionId) && hasCompletedAssistantMessage && !hasError;

  return (
    <div className="ask-selection-shell">
      <section
        className="ask-selection-panel"
        aria-label="Ask Selection result"
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
        <div className="ask-selection-body" ref={messageListRef}>
          {payload.state === "recording" && !hasMessages && (
            <div className="ask-selection-centered-state" role="status">
              <div className="ask-selection-audio-bars" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
              </div>
              <span>Listening...</span>
            </div>
          )}
          {payload.state === "thinking" && !hasMessages && (
            <div className="ask-selection-centered-state" role="status">
              <RoseThreeLoader
                className="ask-selection-loader"
                ariaLabel="Thinking"
              />
              <span>Thinking...</span>
            </div>
          )}
          {hasMessages && (
            <div className="ask-selection-messages">
              {messages.map((message, index) => {
                const isAssistant = message.role === "assistant";
                const messageClass = `ask-selection-message ask-selection-message-${isAssistant ? "assistant" : "user"}${message.pending ? " ask-selection-message-pending" : ""}`;
                if (isAssistant && !message.pending) {
                  return (
                    <button
                      type="button"
                      className={messageClass}
                      onClick={() => void handleCopy(message.text)}
                      key={`${message.role}-${index}`}
                    >
                      {message.text}
                    </button>
                  );
                }

                return (
                  <div className={messageClass} key={`${message.role}-${index}`}>
                    {message.pending && isAssistant ? (
                      <>
                        <RoseThreeLoader
                          className="ask-selection-message-loader"
                          ariaLabel="Thinking"
                        />
                        <span>Thinking...</span>
                      </>
                    ) : (
                      message.text
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {hasError && (
            <p className="ask-selection-error">
              {payload.error?.trim() || "Ask Selection failed."}
            </p>
          )}
        </div>
        {canChat && (
          <div className="ask-selection-composer">
            <textarea
              aria-label="Follow-up message"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              disabled={isSending}
            />
          </div>
        )}
      </section>
    </div>
  );
}

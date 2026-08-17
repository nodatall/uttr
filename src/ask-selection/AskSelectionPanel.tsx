import { listen } from "@tauri-apps/api/event";
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
import { commands } from "@/bindings";
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
  selectedText?: string | null;
  error?: string | null;
  sessionId?: number | null;
  messages?: AskSelectionMessage[] | null;
};

const DEFAULT_PAYLOAD: AskSelectionPayload = {
  state: "thinking",
  text: null,
  selectedText: null,
  error: null,
  sessionId: null,
  messages: [],
};

const payloadsMatch = (
  first: AskSelectionPayload | null,
  second: AskSelectionPayload,
) =>
  first !== null &&
  first.state === second.state &&
  (first.text ?? null) === (second.text ?? null) &&
  (first.selectedText ?? null) === (second.selectedText ?? null) &&
  (first.error ?? null) === (second.error ?? null) &&
  (first.sessionId ?? null) === (second.sessionId ?? null) &&
  JSON.stringify(first.messages ?? []) ===
    JSON.stringify(second.messages ?? []);

const closePanel = () => {
  void commands
    .hideAskSelectionPanel()
    .then((result) => {
      if (result.status === "error") {
        void getCurrentWindow().hide();
      }
    })
    .catch(() => {
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

  void commands
    .startAskSelectionPanelDrag()
    .then((result) => {
      if (result.status === "error") {
        return getCurrentWindow().startDragging();
      }
    })
    .catch(() => getCurrentWindow().startDragging())
    .catch((error) => {
      console.warn("Ask Selection drag failed:", error);
    });
};

const useAskSelectionPanelController = () => {
  const [payload, setPayload] = useState<AskSelectionPayload | null>(null);
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const payloadRef = useRef<AskSelectionPayload | null>(null);
  const copyResetRef = useRef<number | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const applyPayloadRef = useRef<
    (nextPayload: AskSelectionPayload | null) => void
  >(() => {});
  const refreshPayloadRef = useRef<() => void>(() => {});

  const applyPayload = useCallback(
    (nextPayload: AskSelectionPayload | null) => {
      if (nextPayload === null) {
        if (payloadRef.current === null) {
          return;
        }
        payloadRef.current = null;
        setPayload(null);
        setCopied(false);
        setIsSending(false);
        return;
      }

      const normalizedPayload = {
        ...DEFAULT_PAYLOAD,
        ...nextPayload,
        messages: nextPayload?.messages ?? [],
      };
      if (payloadsMatch(payloadRef.current, normalizedPayload)) {
        return;
      }

      payloadRef.current = normalizedPayload;
      setPayload(normalizedPayload);
      setCopied(false);
      setIsSending(normalizedPayload.state === "thinking");
    },
    [],
  );

  const refreshPayload = useCallback(() => {
    void commands
      .getAskSelectionPayload()
      .then((latestPayload) => {
        applyPayload(latestPayload as AskSelectionPayload | null);
      })
      .catch(() => {});
  }, [applyPayload]);

  applyPayloadRef.current = applyPayload;
  refreshPayloadRef.current = refreshPayload;

  useEffect(() => {
    const unlistenPromise = listen<AskSelectionPayload | null>(
      "ask-selection-state",
      (event) => {
        applyPayloadRef.current(event.payload);
      },
    );

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        closePanel();
      }
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        refreshPayloadRef.current();
      }
    };

    refreshPayloadRef.current();
    window.addEventListener("keydown", handleKeyDown);
    const handleFocus = () => refreshPayloadRef.current();
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [applyPayloadRef, copyResetRef, refreshPayloadRef]);

  useEffect(() => {
    if (
      payload === null ||
      (payload.state !== "thinking" && payload.state !== "recording")
    ) {
      return;
    }

    const interval = window.setInterval(() => {
      refreshPayload();
    }, 500);

    return () => {
      window.clearInterval(interval);
    };
  }, [payload, refreshPayload]);

  useEffect(() => {
    messageListRef.current?.scrollTo({
      top: messageListRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [payload?.messages?.length, payload?.state]);

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
    const sessionId = payload?.sessionId;
    if (!message || !sessionId || isSending) {
      return;
    }

    const optimisticMessages = [
      ...(payload?.messages ?? []),
      { role: "user", text: message, pending: false },
      { role: "assistant", text: "Thinking...", pending: true },
    ];
    const optimisticPayload: AskSelectionPayload = {
      ...(payload ?? DEFAULT_PAYLOAD),
      state: "thinking",
      messages: optimisticMessages,
    };
    payloadRef.current = optimisticPayload;
    setPayload(optimisticPayload);
    setDraft("");
    setCopied(false);
    setIsSending(true);

    try {
      const result = await commands.askSelectionFollowUp(sessionId, message);
      if (result.status === "ok") {
        applyPayload(result.data as AskSelectionPayload);
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      const errorPayload: AskSelectionPayload = {
        ...(payloadRef.current ?? DEFAULT_PAYLOAD),
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
  const messages = useMemo(() => payload?.messages ?? [], [payload?.messages]);
  const selectedText = payload?.selectedText?.trim() ?? "";
  const hasError = payload?.state === "error";
  const hasMessages = messages.length > 0;
  const hasCompletedAssistantMessage = messages.some(
    (message) => message.role === "assistant" && !message.pending,
  );
  const canChat =
    Boolean(payload?.sessionId) && hasCompletedAssistantMessage && !hasError;

  return {
    payload,
    copied,
    draft,
    isSending,
    messageListRef,
    messages,
    selectedText,
    hasError,
    hasMessages,
    canChat,
    statusText,
    setDraft,
    handleCopy,
    handleComposerKeyDown,
  };
};

export default function AskSelectionPanel() {
  const {
    payload,
    copied,
    draft,
    isSending,
    messageListRef,
    messages,
    selectedText,
    hasError,
    hasMessages,
    canChat,
    statusText,
    setDraft,
    handleCopy,
    handleComposerKeyDown,
  } = useAskSelectionPanelController();

  if (payload === null) {
    return <div className="ask-selection-shell" />;
  }

  return (
    <div className="ask-selection-shell">
      <section
        className="ask-selection-panel"
        aria-label="Ask Selection result"
        data-tauri-drag-region
      >
        <header
          className="ask-selection-header"
          data-tauri-drag-region
          role="presentation"
          onMouseDown={startPanelDrag}
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
          {selectedText && (
            <div
              className="ask-selection-selected-text"
              aria-label="Selected text"
            >
              {selectedText}
            </div>
          )}
          {payload.state === "recording" && !hasMessages && (
            <output className="ask-selection-centered-state">
              <div className="ask-selection-audio-bars" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
              </div>
              <span>Listening...</span>
            </output>
          )}
          {payload.state === "thinking" && !hasMessages && (
            <output className="ask-selection-centered-state">
              <RoseThreeLoader
                className="ask-selection-loader"
                ariaLabel="Thinking"
              />
              <span>Thinking...</span>
            </output>
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
                  <div
                    className={messageClass}
                    key={`${message.role}-${index}`}
                  >
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

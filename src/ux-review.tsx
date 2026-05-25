/* eslint-disable i18next/no-literal-string */
import "./uxReviewMocks";

import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { Agentation, type Annotation } from "agentation";

declare global {
  interface Window {
    __UTTR_AGENTATION_LAST_COPY__?: string;
    __UTTR_AGENTATION_LAST_SUBMIT__?: {
      output: string;
      annotations: Annotation[];
    };
  }
}

type AgentationOutputState = {
  output: string;
  copied: boolean;
  source: "copy" | "submit";
};

async function copyTextWithFallback(text: string) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    if (document.execCommand("copy")) {
      return true;
    }
  } catch {
  } finally {
    textarea.remove();
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Codex's in-app browser can deny async clipboard writes. When that
    // happens the visible textarea remains the reliable transfer path.
  }

  return false;
}

const AgentationReviewTools = () => {
  const [outputState, setOutputState] = useState<AgentationOutputState | null>(
    null,
  );
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const handleOutput = useCallback(
    (source: AgentationOutputState["source"], output: string) => {
      void copyTextWithFallback(output).then((copied) => {
        setOutputState({ output, copied, source });
      });
    },
    [],
  );

  useEffect(() => {
    if (outputState && !outputState.copied) {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    }
  }, [outputState]);

  return (
    <>
      <Agentation
        copyToClipboard={false}
        onCopy={(markdown) => {
          window.__UTTR_AGENTATION_LAST_COPY__ = markdown;
          handleOutput("copy", markdown);
          console.info("Agentation generated UX review annotations.");
        }}
        onSubmit={(output, annotations) => {
          window.__UTTR_AGENTATION_LAST_SUBMIT__ = {
            output,
            annotations,
          };
          handleOutput("submit", output);
          console.info(
            `Agentation submitted ${annotations.length} UX review annotation(s).`,
          );
        }}
      />

      {outputState && (
        <aside
          aria-live="polite"
          style={{
            position: "fixed",
            top: 16,
            right: 16,
            zIndex: 10000,
            width: "min(520px, calc(100vw - 32px))",
            padding: 14,
            border: "1px solid rgba(255,255,255,0.14)",
            borderRadius: 14,
            background: "rgba(5,10,18,0.94)",
            boxShadow: "0 18px 48px rgba(0,0,0,0.42)",
            color: "#e6edf3",
            fontFamily: "Space Grotesk, Avenir Next, Segoe UI, sans-serif",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              marginBottom: 10,
            }}
          >
            <div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>
                Agentation output
              </div>
              <div style={{ color: "rgba(230,237,243,0.64)", fontSize: 12 }}>
                {outputState.copied
                  ? "Copied to clipboard."
                  : "Clipboard was blocked. The text is selected below for manual copy."}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() =>
                  handleOutput(outputState.source, outputState.output)
                }
                style={{
                  height: 30,
                  padding: "0 10px",
                  borderRadius: 999,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "rgba(103,215,163,0.16)",
                  color: "#8ff0bf",
                  cursor: "pointer",
                }}
              >
                Copy
              </button>
              <button
                type="button"
                aria-label="Close Agentation output"
                onClick={() => setOutputState(null)}
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 999,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "rgba(255,255,255,0.06)",
                  color: "rgba(230,237,243,0.78)",
                  cursor: "pointer",
                }}
              >
                ×
              </button>
            </div>
          </div>
          <textarea
            ref={textareaRef}
            readOnly
            value={outputState.output}
            style={{
              width: "100%",
              height: 170,
              resize: "vertical",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 10,
              background: "rgba(0,0,0,0.32)",
              color: "#dce7ef",
              font: "12px ui-monospace, SFMono-Regular, Menlo, monospace",
              lineHeight: 1.45,
              padding: 10,
              outline: "none",
            }}
          />
        </aside>
      )}
    </>
  );
};

const mountAgentation = () => {
  const container = document.createElement("div");
  container.id = "agentation-root";
  document.body.appendChild(container);

  ReactDOM.createRoot(container).render(
    <React.StrictMode>
      <AgentationReviewTools />
    </React.StrictMode>,
  );
};

void import("./main").then(mountAgentation);

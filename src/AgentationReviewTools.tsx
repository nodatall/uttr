/* eslint-disable i18next/no-literal-string */
import { useCallback, useRef, useState } from "react";
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

export function AgentationReviewTools() {
  const [outputState, setOutputState] = useState<AgentationOutputState | null>(
    null,
  );
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const handleOutput = useCallback(
    (source: AgentationOutputState["source"], output: string) => {
      void copyTextWithFallback(output).then((copied) => {
        setOutputState({ output, copied, source });
        if (!copied) {
          requestAnimationFrame(() => {
            textareaRef.current?.focus();
            textareaRef.current?.select();
          });
        }
      });
    },
    [],
  );

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
        <aside aria-live="polite" className="agentation-output">
          <div className="agentation-output-header">
            <div>
              <div className="agentation-output-title">Agentation output</div>
              <div className="agentation-output-status">
                {outputState.copied
                  ? "Copied to clipboard."
                  : "Clipboard was blocked. The text is selected below for manual copy."}
              </div>
            </div>
            <div className="agentation-output-actions">
              <button
                type="button"
                onClick={() =>
                  handleOutput(outputState.source, outputState.output)
                }
                className="agentation-output-copy"
              >
                Copy
              </button>
              <button
                type="button"
                aria-label="Close Agentation output"
                onClick={() => setOutputState(null)}
                className="agentation-output-close"
              >
                x
              </button>
            </div>
          </div>
          <textarea
            ref={textareaRef}
            readOnly
            aria-label="Agentation output"
            value={outputState.output}
            className="agentation-output-textarea"
          />
        </aside>
      )}
    </>
  );
}

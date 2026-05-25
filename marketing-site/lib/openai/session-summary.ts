import { readOpenAiSummaryConfig } from "@/lib/env";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_SUMMARY_TIMEOUT_MS = 45_000;

export interface SessionSummaryInput {
  transcriptText: string;
  previousSummary?: string | null;
}

interface OpenAiChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

function buildSummaryPrompt(input: SessionSummaryInput) {
  const previous = input.previousSummary?.trim() || "No previous summary yet.";

  return `Update the live session summary from the transcript so far.

Previous summary:
${previous}

Transcript so far:
${input.transcriptText}

Return concise markdown with:
- Summary
- Action items
- Notable points

Do not invent details that are not in the transcript.`;
}

function extractAssistantText(payload: OpenAiChatCompletionResponse) {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === "text" ? part.text || "" : ""))
      .join("")
      .trim();
  }

  return "";
}

export async function summarizeSessionWithOpenAi(input: SessionSummaryInput) {
  const { openAiApiKey, openAiSummaryModelDefault } = readOpenAiSummaryConfig();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    OPENAI_SUMMARY_TIMEOUT_MS,
  );

  try {
    const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${openAiApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: openAiSummaryModelDefault,
        messages: [
          {
            role: "system",
            content:
              "You summarize live desktop audio sessions. Be concise, concrete, and faithful to the transcript.",
          },
          {
            role: "user",
            content: buildSummaryPrompt(input),
          },
        ],
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      await response.arrayBuffer().catch(() => null);
      throw new Error(
        `OpenAI summary request failed (${response.status} ${response.statusText})`,
      );
    }

    const payload = (await response.json()) as OpenAiChatCompletionResponse;
    const summary = extractAssistantText(payload);
    if (!summary) {
      throw new Error("OpenAI summary response missing text.");
    }

    return summary;
  } finally {
    clearTimeout(timeout);
  }
}

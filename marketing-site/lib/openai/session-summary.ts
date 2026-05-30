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

export const SESSION_SUMMARY_SYSTEM_PROMPT =
  "You are the live meeting summarizer inside Uttr, a macOS transcription app. Update meeting notes from transcript text only. Return valid JSON only with current_gist and expanded key_points.";

export function buildSummaryPrompt(input: SessionSummaryInput) {
  const previous = input.previousSummary?.trim() || "No previous summary yet.";

  return `Update the live meeting summary incrementally.

Rules:
- Use only facts supported by the transcript.
- Do not invent decisions, tasks, names, deadlines, or speakers.
- Preserve useful existing information.
- Merge duplicates.
- Use only Current gist and Key points.
- Do not include action items, timelines, decisions, open questions, or raw transcript.
- Make key points more expanded than terse bullets: use short topic bullets with one to three concrete supporting details when the transcript supports them.
- Keep the gist concise and keep key point detail readable in a desktop meeting UI.

Previous rendered summary:
${previous}

Transcript so far:
${input.transcriptText}

Return valid JSON only. Do not include markdown, code fences, commentary, or extra fields.

Use exactly this shape:
{
  "current_gist": "one to three concise sentences",
  "key_points": [
    {
      "text": "short topic or important discussion point",
      "details": [
        "expanded supporting detail, tradeoff, rationale, or context from the transcript",
        "another concrete detail when useful"
      ]
    }
  ]
}

Rendered sections must map only to: Current gist, Key points.`;
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
            content: SESSION_SUMMARY_SYSTEM_PROMPT,
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

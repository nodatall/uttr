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
  "You are the live meeting summarizer inside Uttr, a macOS transcription app. Update meeting notes from transcript text only. Return valid JSON only.";

export function buildSummaryPrompt(input: SessionSummaryInput) {
  const previous = input.previousSummary?.trim() || "No previous summary yet.";

  return `Update the live meeting summary incrementally.

Rules:
- Use only facts supported by the transcript.
- Do not invent decisions, tasks, names, deadlines, or speakers.
- Preserve useful existing information.
- Merge duplicates.
- If a task has no owner, use "Unassigned".
- If a task has no deadline, use "No deadline".
- Keep all text concise for a desktop meeting UI.

Previous rendered summary:
${previous}

Transcript so far:
${input.transcriptText}

Return valid JSON only. Do not include markdown, code fences, commentary, or extra fields.

Use exactly this shape:
{
  "current_gist": "one to three concise sentences",
  "key_points": [
    { "text": "important discussion point" }
  ],
  "action_items": [
    {
      "task": "specific task",
      "owner": "owner name or Unassigned",
      "deadline": "deadline or No deadline",
      "status": "Open"
    }
  ],
  "timeline": [
    { "time": "chunk or timestamp", "event": "brief event or topic change" }
  ]
}

Rendered sections must map only to: Current gist, Key points, Action items, Timeline.`;
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

import { createHash } from "node:crypto";
import { readCloudProxyConfig } from "@/lib/env";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const GROQ_UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024;
const GROQ_DEFAULT_TRANSLATION_MODEL = "whisper-large-v3";
const GROQ_ALLOWED_TRANSCRIPTION_MODELS = new Set([
  "whisper-large-v3",
  "whisper-large-v3-turbo",
]);

export type GroqTranscriptionEndpoint =
  | "audio/transcriptions"
  | "audio/translations";

export interface GroqTranscriptionInput {
  audioFile: Blob | File;
  fileName?: string;
  mimeType?: string;
  language?: string | null;
  model?: string | null;
  translateToEnglish: boolean;
}

export interface GroqTranscriptionResult {
  text: string;
  endpoint: GroqTranscriptionEndpoint;
  model: string;
}

export function normalizeGroqLanguage(language: string | null | undefined) {
  if (!language) {
    return null;
  }

  const trimmed = language.trim();
  if (!trimmed || trimmed === "auto") {
    return null;
  }

  if (trimmed === "zh-Hans" || trimmed === "zh-Hant") {
    return "zh";
  }

  return trimmed;
}

export function resolveGroqTranscriptionModel(
  requestedModel: string | null | undefined,
  translateToEnglish: boolean,
) {
  const { groqModelDefault } = readCloudProxyConfig();
  const requested = requestedModel?.trim();
  const configuredDefault =
    groqModelDefault.trim() || GROQ_DEFAULT_TRANSLATION_MODEL;
  const resolved =
    requested && GROQ_ALLOWED_TRANSCRIPTION_MODELS.has(requested)
      ? requested
      : configuredDefault;

  if (translateToEnglish && resolved.toLowerCase().includes("turbo")) {
    return GROQ_DEFAULT_TRANSLATION_MODEL;
  }

  return resolved;
}

export function resolveGroqEndpoint(
  translateToEnglish: boolean,
): GroqTranscriptionEndpoint {
  return translateToEnglish ? "audio/translations" : "audio/transcriptions";
}

export function isGroqUploadWithinLimit(byteLength: number) {
  return byteLength <= GROQ_UPLOAD_LIMIT_BYTES;
}

export function estimateAudioSecondsFromWavBytes(byteLength: number) {
  return Math.max(0, Math.ceil(Math.max(byteLength - 44, 0) / 32000));
}

export function summarizeGroqPayload(fileName: string, model: string) {
  return createHash("sha256")
    .update(`${fileName}:${model}`)
    .digest("hex")
    .slice(0, 12);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(value: string | null) {
  if (!value) {
    return null;
  }

  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const retryAt = new Date(value).getTime();
  if (Number.isFinite(retryAt)) {
    return Math.max(0, retryAt - Date.now());
  }

  return null;
}

function isRetryableGroqStatus(status: number) {
  return status === 429 || status === 408 || status >= 500;
}

async function fetchGroqWithRetry(
  url: string,
  buildInit: () => RequestInit,
  maxAttempts = 3,
) {
  const attemptFetch = async (attempt: number): Promise<Response> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);

    try {
      const response = await fetch(url, {
        ...buildInit(),
        signal: controller.signal,
      });

      if (
        response.ok ||
        !isRetryableGroqStatus(response.status) ||
        attempt === maxAttempts
      ) {
        return response;
      }

      const retryAfterMs = parseRetryAfterMs(
        response.headers.get("retry-after"),
      );
      await response.arrayBuffer().catch(() => null);
      await sleep(Math.min(retryAfterMs ?? 250 * 2 ** (attempt - 1), 2_000));
      return attemptFetch(attempt + 1);
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error instanceof Error
          ? error
          : new Error("Groq request failed before receiving a response.");
      }

      await sleep(250 * 2 ** (attempt - 1));
      return attemptFetch(attempt + 1);
    } finally {
      clearTimeout(timeout);
    }
  };

  return attemptFetch(1);
}

export async function transcribeWithGroq({
  audioFile,
  fileName = "uttr.wav",
  language,
  model,
  translateToEnglish,
}: GroqTranscriptionInput) {
  const { groqApiKey } = readCloudProxyConfig();
  const resolvedModel = resolveGroqTranscriptionModel(
    model,
    translateToEnglish,
  );
  const endpoint = resolveGroqEndpoint(translateToEnglish);
  const normalizedLanguage = normalizeGroqLanguage(language);

  const response = await fetchGroqWithRetry(
    `${GROQ_BASE_URL}/${endpoint}`,
    () => {
      const body = new FormData();

      body.set("model", resolvedModel);
      body.set("response_format", "json");
      if (normalizedLanguage) {
        body.set("language", normalizedLanguage);
      }
      body.set("file", audioFile, fileName);

      return {
        method: "POST",
        headers: {
          authorization: `Bearer ${groqApiKey}`,
        },
        body,
      };
    },
  );

  if (!response.ok) {
    await response.arrayBuffer().catch(() => null);
    throw new Error(
      `Groq API request failed (${response.status} ${response.statusText})`,
    );
  }

  const payload = (await response.json()) as { text?: string };
  if (typeof payload.text !== "string") {
    throw new Error("Groq transcription response missing text.");
  }

  return {
    text: payload.text,
    endpoint,
    model: resolvedModel,
  } satisfies GroqTranscriptionResult;
}

import { createHash } from "node:crypto";
import { readCloudProxyConfig } from "@/lib/env";

export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
export const GROQ_UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;
export const GROQ_DEFAULT_TRANSLATION_MODEL = "whisper-large-v3";

export type GroqTranscriptionEndpoint = "audio/transcriptions" | "audio/translations";

export interface GroqTranscriptionInput {
  audioBytes: ArrayBuffer | Uint8Array;
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
  const resolved = requestedModel?.trim() || groqModelDefault;

  if (translateToEnglish && resolved.toLowerCase().includes("turbo")) {
    return GROQ_DEFAULT_TRANSLATION_MODEL;
  }

  return resolved;
}

export function resolveGroqEndpoint(translateToEnglish: boolean): GroqTranscriptionEndpoint {
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

export async function transcribeWithGroq({
  audioBytes,
  fileName = "uttr.wav",
  mimeType = "audio/wav",
  language,
  model,
  translateToEnglish,
}: GroqTranscriptionInput) {
  const { groqApiKey } = readCloudProxyConfig();
  const resolvedModel = resolveGroqTranscriptionModel(model, translateToEnglish);
  const endpoint = resolveGroqEndpoint(translateToEnglish);
  const body = new FormData();

  body.set("model", resolvedModel);
  body.set("response_format", "json");

  const normalizedLanguage = normalizeGroqLanguage(language);
  if (normalizedLanguage) {
    body.set("language", normalizedLanguage);
  }

  const blobBytes =
    audioBytes instanceof Uint8Array ? Uint8Array.from(audioBytes) : new Uint8Array(audioBytes);
  const blob = new Blob([blobBytes], { type: mimeType });
  body.set("file", blob, fileName);

  const response = await fetch(`${GROQ_BASE_URL}/${endpoint}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${groqApiKey}`,
    },
    body,
  });

  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");
    throw new Error(
      `Groq API request failed (${response.status} ${response.statusText}): ${responseBody || "empty response body"}`,
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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  estimateAudioSecondsFromWavBytes,
  isGroqUploadWithinLimit,
  normalizeGroqLanguage,
  resolveGroqEndpoint,
  resolveGroqTranscriptionModel,
  summarizeGroqPayload,
  transcribeWithGroq,
} from "./transcription";

const originalGroqModelDefault = process.env.GROQ_TRANSCRIPTION_MODEL_DEFAULT;
const originalGroqApiKey = process.env.GROQ_API_KEY;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.GROQ_TRANSCRIPTION_MODEL_DEFAULT = "whisper-large-v3";
  process.env.GROQ_API_KEY = "groq-key-test";
});

afterEach(() => {
  process.env.GROQ_TRANSCRIPTION_MODEL_DEFAULT = originalGroqModelDefault;
  process.env.GROQ_API_KEY = originalGroqApiKey;
  globalThis.fetch = originalFetch;
});

describe("Groq transcription helpers", () => {
  test("normalizes language codes and blank values", () => {
    expect(normalizeGroqLanguage(undefined)).toBeNull();
    expect(normalizeGroqLanguage("auto")).toBeNull();
    expect(normalizeGroqLanguage(" zh-Hans ")).toBe("zh");
    expect(normalizeGroqLanguage("en-US")).toBe("en-US");
  });

  test("resolves translation model defaults and turbo fallbacks", () => {
    expect(resolveGroqTranscriptionModel(null, false)).toBe("whisper-large-v3");
    expect(resolveGroqTranscriptionModel("  custom-model  ", false)).toBe(
      "custom-model",
    );
    expect(resolveGroqTranscriptionModel("super-turbo", true)).toBe(
      "whisper-large-v3",
    );
  });

  test("exposes upload limits and timing-related payload helpers", () => {
    expect(isGroqUploadWithinLimit(100 * 1024 * 1024)).toBe(true);
    expect(isGroqUploadWithinLimit(100 * 1024 * 1024 + 1)).toBe(false);
    expect(estimateAudioSecondsFromWavBytes(44)).toBe(0);
    expect(estimateAudioSecondsFromWavBytes(44 + 64_000)).toBe(2);
    expect(resolveGroqEndpoint(true)).toBe("audio/translations");
    expect(resolveGroqEndpoint(false)).toBe("audio/transcriptions");
    expect(summarizeGroqPayload("uttr.wav", "model-a")).toHaveLength(12);
  });

  test("retries transient Groq provider failures", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("busy", { status: 503, statusText: "Unavailable" });
      }

      return Response.json({ text: "retry success" });
    }) as typeof fetch;

    const result = await transcribeWithGroq({
      audioFile: new File([new Uint8Array([1, 2, 3])], "uttr.wav", {
        type: "audio/wav",
      }),
      translateToEnglish: false,
    });

    expect(result.text).toBe("retry success");
    expect(attempts).toBe(2);
  });
});

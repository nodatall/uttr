import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  estimateAudioSecondsFromWavBytes,
  isGroqUploadWithinLimit,
  normalizeGroqLanguage,
  resolveGroqEndpoint,
  resolveGroqTranscriptionModel,
  summarizeGroqPayload,
} from "./transcription";

const originalGroqModelDefault = process.env.GROQ_TRANSCRIPTION_MODEL_DEFAULT;
const originalGroqApiKey = process.env.GROQ_API_KEY;

beforeEach(() => {
  process.env.GROQ_TRANSCRIPTION_MODEL_DEFAULT = "whisper-large-v3";
  process.env.GROQ_API_KEY = "groq-key-test";
});

afterEach(() => {
  process.env.GROQ_TRANSCRIPTION_MODEL_DEFAULT = originalGroqModelDefault;
  process.env.GROQ_API_KEY = originalGroqApiKey;
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
    expect(isGroqUploadWithinLimit(25 * 1024 * 1024)).toBe(true);
    expect(isGroqUploadWithinLimit(25 * 1024 * 1024 + 1)).toBe(false);
    expect(estimateAudioSecondsFromWavBytes(44)).toBe(0);
    expect(estimateAudioSecondsFromWavBytes(44 + 64_000)).toBe(2);
    expect(resolveGroqEndpoint(true)).toBe("audio/translations");
    expect(resolveGroqEndpoint(false)).toBe("audio/transcriptions");
    expect(summarizeGroqPayload("uttr.wav", "model-a")).toHaveLength(12);
  });
});

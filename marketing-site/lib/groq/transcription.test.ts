import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { transcribeWithGroq } from "./transcription";

const originalGroqModelDefault = process.env.GROQ_TRANSCRIPTION_MODEL_DEFAULT;
const originalGroqApiKey = process.env.GROQ_API_KEY;
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

beforeEach(() => {
  process.env.GROQ_TRANSCRIPTION_MODEL_DEFAULT = "whisper-large-v3";
  process.env.GROQ_API_KEY = "groq-key-test";
});

afterEach(() => {
  process.env.GROQ_TRANSCRIPTION_MODEL_DEFAULT = originalGroqModelDefault;
  process.env.GROQ_API_KEY = originalGroqApiKey;
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

describe("Groq transcription helpers", () => {
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

  test("keeps the request deadline active while consuming the response body", async () => {
    let attempts = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        attempts += 1;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"text":"'));
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    globalThis.fetch = ((_url, init) =>
      originalFetch(server.url, init)) as typeof fetch;
    globalThis.setTimeout = ((
      callback: Parameters<typeof setTimeout>[0],
      delay?: number,
      ...args: unknown[]
    ) =>
      originalSetTimeout(
        callback,
        delay === 90_000 ? 20 : 1,
        ...args,
      )) as typeof setTimeout;

    try {
      await expect(
        transcribeWithGroq({
          audioFile: new Blob([new Uint8Array([1, 2, 3])]),
          translateToEnglish: false,
        }),
      ).rejects.toThrow();
      expect(attempts).toBe(3);
    } finally {
      server.stop(true);
    }
  }, 1_000);

  test("redacts provider error bodies from thrown messages", async () => {
    globalThis.fetch = (async () =>
      new Response("provider included sensitive detail", {
        status: 400,
        statusText: "Bad Request",
      })) as typeof fetch;

    await expect(
      transcribeWithGroq({
        audioFile: new File([new Uint8Array([1, 2, 3])], "uttr.wav", {
          type: "audio/wav",
        }),
        translateToEnglish: false,
      }),
    ).rejects.toThrow("Groq API request failed (400 Bad Request)");
  });
});

import { beforeEach, describe, expect, mock, test } from "bun:test";

const trial = {
  id: "trial_123",
  install_id: "install_123",
  device_fingerprint_hash: "device_123",
  user_id: null,
  status: "trialing",
  trial_started_at: new Date(Date.now() - 60_000).toISOString(),
  trial_ends_at: new Date(Date.now() + 60_000).toISOString(),
  last_seen_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const usageEventCalls: Array<Record<string, unknown>> = [];
const callOrder: string[] = [];
let transcribeShouldFail = false;

mock.module("@/lib/access", () => ({
  fetchAnonymousTrialById: async () => trial,
  fetchEntitlementByUserId: async () => null,
  fetchUsageEventsSince: async () => [],
  insertUsageEvent: async (row: Record<string, unknown>) => {
    callOrder.push("insert_usage");
    usageEventCalls.push(row);
    return { id: "usage_123", ...row };
  },
  patchAnonymousTrialById: async () => trial,
  readInstallTokenFromRequest: () => "install-token",
  refreshAnonymousTrialState: async () => trial,
  resolveAccessDecision: () => ({
    accessState: "trialing",
    trialState: "trialing",
    entitlementState: "inactive",
  }),
  verifyInstallToken: () => ({
    version: 1,
    anonymous_trial_id: trial.id,
    install_id: trial.install_id,
    device_fingerprint_hash: trial.device_fingerprint_hash,
    issued_at: new Date().toISOString(),
  }),
}));

mock.module("@/lib/access/cloud-transcription-policy", () => ({
  evaluateCloudTranscriptionPreflight: () => ({ allowed: true }),
}));

mock.module("@/lib/groq", () => ({
  estimateAudioSecondsFromWavBytes: () => 12,
  isGroqUploadWithinLimit: () => true,
  summarizeGroqPayload: () => "trace_123",
  transcribeWithGroq: async () => {
    callOrder.push("transcribe");
    if (transcribeShouldFail) {
      throw new Error("provider failed");
    }
    return {
      endpoint: "transcriptions",
      model: "whisper-large-v3",
      text: "hello world",
    };
  },
}));

mock.module("@/lib/groq/timings", () => ({
  buildTimings: () => ({
    total_ms: 10,
    pre_provider_ms: 2,
    provider_ms: 7,
    post_provider_ms: 1,
  }),
}));

mock.module("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({
    allowed: true,
    remaining: 59,
    source: "memory",
  }),
  rateLimitKeyFromRequest: () => "cloud-transcribe:test",
  resolveRateLimitFailure: () => ({
    status: 429,
    error: "Too many transcription requests.",
    retryAfterSeconds: 60,
  }),
}));

const { POST } = await import("./route");

beforeEach(() => {
  usageEventCalls.length = 0;
  callOrder.length = 0;
  transcribeShouldFail = false;
});

function buildRequest() {
  const formData = new FormData();
  formData.set(
    "file",
    new File([new Uint8Array([1, 2, 3])], "sample.wav", {
      type: "audio/wav",
    }),
  );

  return new Request("https://uttr.test/api/transcribe/cloud", {
    method: "POST",
    body: formData,
  });
}

describe("/api/transcribe/cloud usage accounting", () => {
  test("records usage after provider transcription succeeds", async () => {
    const response = await POST(buildRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.text).toBe("hello world");
    expect(callOrder).toEqual(["transcribe", "insert_usage"]);
    expect(usageEventCalls).toEqual([
      {
        anonymous_trial_id: trial.id,
        user_id: null,
        source: "cloud_default",
        audio_seconds: 12,
      },
    ]);
  });

  test("does not spend trial usage when provider transcription fails", async () => {
    transcribeShouldFail = true;

    const response = await POST(buildRequest());
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload.error).toBe("Could not transcribe audio.");
    expect(callOrder).toEqual(["transcribe"]);
    expect(usageEventCalls).toHaveLength(0);
  });
});

import { beforeEach, describe, expect, mock, test } from "bun:test";

type MockTrial = {
  id: string;
  install_id: string;
  device_fingerprint_hash: string;
  user_id: string | null;
  status: string;
  trial_started_at: string;
  trial_ends_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
};

type MockAccessDecision = {
  accessState: "blocked" | "trialing" | "subscribed";
  trialState: "new" | "trialing" | "expired" | "linked";
  entitlementState: "inactive" | "active" | "past_due" | "canceled" | "expired";
};

const trial: MockTrial = {
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

let currentTrial: MockTrial = trial;
let currentAccessDecision: MockAccessDecision = {
  accessState: "trialing",
  trialState: "trialing",
  entitlementState: "inactive",
};
const usageEventCalls: Array<Record<string, unknown>> = [];
const callOrder: string[] = [];
const transcribeInputs: Array<Record<string, unknown>> = [];
let transcribeShouldFail = false;
const lockedExecutor = { query: async () => ({ rows: [], rowCount: 0 }) };

mock.module("@/lib/access", () => ({
  fetchAnonymousTrialById: async () => currentTrial,
  fetchEntitlementByUserId: async () => null,
  fetchUsageEventsSince: async (_params: unknown, executor?: unknown) => {
    callOrder.push(
      executor === lockedExecutor ? "fetch_usage_locked" : "fetch_usage_pool",
    );
    return [];
  },
  fetchUserUsageEventsSince: async (
    params: { since?: string },
    executor?: unknown,
  ) => {
    callOrder.push(
      executor === lockedExecutor
        ? "fetch_user_usage_locked"
        : "fetch_user_usage_pool",
    );
    return params.since ? [] : [];
  },
  insertUsageEvent: async (
    row: Record<string, unknown>,
    executor?: unknown,
  ) => {
    callOrder.push(
      executor === lockedExecutor ? "insert_usage_locked" : "insert_usage_pool",
    );
    usageEventCalls.push(row);
    return { id: "usage_123", ...row };
  },
  patchAnonymousTrialById: async (
    _id: string,
    _patch: unknown,
    executor?: unknown,
  ) => {
    callOrder.push(
      executor === lockedExecutor ? "patch_trial_locked" : "patch_trial_pool",
    );
    return currentTrial;
  },
  readInstallTokenFromRequest: () => "install-token",
  refreshAnonymousTrialState: async () => currentTrial,
  resolveAccessDecision: () => currentAccessDecision,
  verifyInstallToken: () => ({
    version: 1,
    anonymous_trial_id: currentTrial.id,
    install_id: currentTrial.install_id,
    device_fingerprint_hash: currentTrial.device_fingerprint_hash,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    jti: "install_token_123",
  }),
  withAnonymousTrialUsageLock: async (
    anonymousTrialId: string,
    callback: (executor: typeof lockedExecutor) => Promise<Response>,
  ) => {
    callOrder.push(`lock:${anonymousTrialId}`);
    return callback(lockedExecutor);
  },
  withUserUsageLock: async (
    userId: string,
    callback: (executor: typeof lockedExecutor) => Promise<Response>,
  ) => {
    callOrder.push(`user_lock:${userId}`);
    return callback(lockedExecutor);
  },
}));

mock.module("@/lib/access/cloud-transcription-policy", () => ({
  evaluateCloudTranscriptionPreflight: () => ({ allowed: true }),
}));

mock.module("@/lib/groq", () => ({
  estimateAudioSecondsFromWavBytes: () => 12,
  isGroqUploadWithinLimit: () => true,
  summarizeGroqPayload: () => "trace_123",
  transcribeWithGroq: async (input: Record<string, unknown>) => {
    callOrder.push("transcribe");
    transcribeInputs.push(input);
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

const { POST } = await import("./route");

beforeEach(() => {
  currentTrial = trial;
  currentAccessDecision = {
    accessState: "trialing",
    trialState: "trialing",
    entitlementState: "inactive",
  };
  usageEventCalls.length = 0;
  callOrder.length = 0;
  transcribeInputs.length = 0;
  transcribeShouldFail = false;
});

function buildPcmWavBytes() {
  const bytes = new Uint8Array(48);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([40, 0, 0, 0], 4);
  bytes.set([0x57, 0x41, 0x56, 0x45], 8);
  bytes.set([0x66, 0x6d, 0x74, 0x20], 12);
  bytes.set([16, 0, 0, 0], 16);
  bytes.set([1, 0], 20);
  bytes.set([1, 0], 22);
  bytes.set([0x80, 0x3e, 0, 0], 24);
  bytes.set([0, 0x7d, 0, 0], 28);
  bytes.set([2, 0], 32);
  bytes.set([16, 0], 34);
  bytes.set([0x64, 0x61, 0x74, 0x61], 36);
  bytes.set([4, 0, 0, 0], 40);
  return bytes;
}

function buildRequest(
  fields: Record<string, string> = {},
  file = new File([buildPcmWavBytes()], "sample.wav", {
    type: "audio/wav",
  }),
) {
  const formData = new FormData();
  formData.set("file", file);
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }

  return new Request("https://uttr.test/api/transcribe/cloud", {
    method: "POST",
    headers: {
      "content-length": String(file.size),
    },
    body: formData,
  });
}

describe("/api/transcribe/cloud usage accounting", () => {
  test("records usage after provider transcription succeeds", async () => {
    const response = await POST(buildRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.text).toBe("hello world");
    expect(callOrder).toEqual([
      "lock:trial_123",
      "fetch_usage_locked",
      "patch_trial_locked",
      "transcribe",
      "insert_usage_locked",
    ]);
    expect(usageEventCalls).toEqual([
      {
        anonymous_trial_id: trial.id,
        user_id: null,
        source: "cloud_default",
        audio_seconds: 12,
      },
    ]);
    expect(transcribeInputs[0]?.audioFile).toBeInstanceOf(File);
  });

  test("does not spend trial usage when provider transcription fails", async () => {
    transcribeShouldFail = true;

    const response = await POST(buildRequest());
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload.error).toBe("Could not transcribe audio.");
    expect(callOrder).toEqual([
      "lock:trial_123",
      "fetch_usage_locked",
      "patch_trial_locked",
      "transcribe",
    ]);
    expect(usageEventCalls).toHaveLength(0);
  });

  test("uses server-estimated audio seconds instead of client-supplied duration", async () => {
    const response = await POST(buildRequest({ audio_seconds: "1" }));

    expect(response.status).toBe(200);
    expect(usageEventCalls).toEqual([
      {
        anonymous_trial_id: trial.id,
        user_id: null,
        source: "cloud_default",
        audio_seconds: 12,
      },
    ]);
  });

  test("serializes subscribed usage checks by user", async () => {
    currentTrial = {
      ...trial,
      user_id: "user_123",
      status: "linked",
    };
    currentAccessDecision = {
      accessState: "subscribed",
      trialState: "linked",
      entitlementState: "active",
    };

    const response = await POST(buildRequest());

    expect(response.status).toBe(200);
    expect(callOrder).toEqual([
      "user_lock:user_123",
      "fetch_user_usage_locked",
      "fetch_user_usage_locked",
      "patch_trial_locked",
      "transcribe",
      "insert_usage_locked",
    ]);
    expect(usageEventCalls).toEqual([
      {
        anonymous_trial_id: trial.id,
        user_id: "user_123",
        source: "cloud_default",
        audio_seconds: 12,
      },
    ]);
  });

  test("rejects clearly oversized request bodies before parsing multipart data", async () => {
    const request = new Request("https://uttr.test/api/transcribe/cloud", {
      method: "POST",
      headers: {
        "content-length": String(111 * 1024 * 1024),
      },
    });
    Object.defineProperty(request, "formData", {
      configurable: true,
      value: async () => {
        throw new Error("multipart body should not be parsed when too large");
      },
    });

    const response = await POST(request);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Audio upload exceeds the 100 MB limit.",
    });
    expect(callOrder).toEqual([]);
  });

  test("rejects non-WAV uploads before calling the provider", async () => {
    const response = await POST(
      buildRequest(
        {},
        new File([new Uint8Array([1, 2, 3])], "sample.mp3", {
          type: "audio/mpeg",
        }),
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Audio upload must be a WAV file.",
    });
    expect(callOrder).toEqual([]);
    expect(transcribeInputs).toHaveLength(0);
    expect(usageEventCalls).toHaveLength(0);
  });

  test("rejects uploads without a known content length before parsing multipart data", async () => {
    const request = new Request("https://uttr.test/api/transcribe/cloud", {
      method: "POST",
    });
    Object.defineProperty(request, "formData", {
      configurable: true,
      value: async () => {
        throw new Error("multipart body should not be parsed without length");
      },
    });

    const response = await POST(request);

    expect(response.status).toBe(411);
    await expect(response.json()).resolves.toEqual({
      error: "Audio upload requires a Content-Length header.",
    });
    expect(callOrder).toEqual([]);
  });

  test("rejects malformed content length values before parsing multipart data", async () => {
    const request = new Request("https://uttr.test/api/transcribe/cloud", {
      method: "POST",
      headers: {
        "content-length": "10x",
      },
    });
    Object.defineProperty(request, "formData", {
      configurable: true,
      value: async () => {
        throw new Error("multipart body should not be parsed with bad length");
      },
    });

    const response = await POST(request);

    expect(response.status).toBe(411);
    await expect(response.json()).resolves.toEqual({
      error: "Audio upload requires a Content-Length header.",
    });
    expect(callOrder).toEqual([]);
  });

  test("returns a client error for malformed multipart uploads", async () => {
    const request = new Request("https://uttr.test/api/transcribe/cloud", {
      method: "POST",
      headers: {
        "content-length": "10",
      },
    });
    Object.defineProperty(request, "formData", {
      configurable: true,
      value: async () => {
        throw new Error("invalid multipart payload");
      },
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid multipart audio upload.",
    });
    expect(callOrder).toEqual([]);
  });
});

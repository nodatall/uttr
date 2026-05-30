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
const callOrder: string[] = [];
const summaryInputs: Array<Record<string, unknown>> = [];
let summaryShouldFail = false;
const lockedExecutor = { query: async () => ({ rows: [], rowCount: 0 }) };

mock.module("@/lib/access", () => ({
  fetchAnonymousTrialById: async () => currentTrial,
  fetchEntitlementByUserId: async () => null,
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

mock.module("@/lib/openai/session-summary", () => ({
  summarizeSessionWithOpenAi: async (input: Record<string, unknown>) => {
    callOrder.push("summarize");
    summaryInputs.push(input);
    if (summaryShouldFail) {
      throw new Error("provider failed");
    }
    return "## Summary\n- Important point";
  },
}));

const { POST } = await import("./route");

beforeEach(() => {
  currentTrial = trial;
  currentAccessDecision = {
    accessState: "trialing",
    trialState: "trialing",
    entitlementState: "inactive",
  };
  callOrder.length = 0;
  summaryInputs.length = 0;
  summaryShouldFail = false;
});

function buildRequest(body: Record<string, unknown> = {}) {
  const json = JSON.stringify({
    transcript_text: "Discussed the launch plan and owner assignments.",
    previous_summary: "Earlier context.",
    chunk_count: 2,
    ...body,
  });

  return new Request("https://uttr.test/api/session/summary", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(json).length),
    },
    body: json,
  });
}

describe("/api/session/summary", () => {
  test("returns a backend summary and refreshes the anonymous trial heartbeat", async () => {
    const response = await POST(buildRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.summary).toBe("## Summary\n- Important point");
    expect(payload.trial_state).toBe("trialing");
    expect(payload.access_state).toBe("trialing");
    expect(callOrder).toEqual([
      "lock:trial_123",
      "patch_trial_locked",
      "summarize",
    ]);
    expect(summaryInputs).toEqual([
      {
        transcriptText: "Discussed the launch plan and owner assignments.",
        previousSummary: "Earlier context.",
      },
    ]);
  });

  test("rejects missing transcript text before calling the provider", async () => {
    const response = await POST(buildRequest({ transcript_text: "  " }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Missing transcript text.",
    });
    expect(callOrder).toEqual([]);
    expect(summaryInputs).toHaveLength(0);
  });

  test("serializes subscribed summaries by user", async () => {
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
      "patch_trial_locked",
      "summarize",
    ]);
  });

  test("does not report success when the provider fails", async () => {
    summaryShouldFail = true;

    const response = await POST(buildRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Could not summarize session.",
    });
    expect(callOrder).toEqual([
      "lock:trial_123",
      "patch_trial_locked",
      "summarize",
    ]);
  });

  test("rejects clearly oversized request bodies before parsing JSON", async () => {
    const request = new Request("https://uttr.test/api/session/summary", {
      method: "POST",
      headers: {
        "content-length": String(513 * 1024),
      },
    });
    Object.defineProperty(request, "json", {
      configurable: true,
      value: async () => {
        throw new Error("JSON body should not be parsed when too large");
      },
    });

    const response = await POST(request);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Summary request exceeds the 512 KB limit.",
    });
    expect(callOrder).toEqual([]);
  });

  test("rejects missing request body length before parsing JSON", async () => {
    const request = new Request("https://uttr.test/api/session/summary", {
      method: "POST",
    });
    Object.defineProperty(request, "json", {
      configurable: true,
      value: async () => {
        throw new Error("JSON body should not be parsed without length");
      },
    });

    const response = await POST(request);

    expect(response.status).toBe(411);
    await expect(response.json()).resolves.toEqual({
      error: "Summary request requires a Content-Length header.",
    });
    expect(callOrder).toEqual([]);
  });

  test("rejects malformed request body length before parsing JSON", async () => {
    const request = new Request("https://uttr.test/api/session/summary", {
      method: "POST",
      headers: {
        "content-length": "10x",
      },
      body: "{}",
    });
    Object.defineProperty(request, "json", {
      configurable: true,
      value: async () => {
        throw new Error("JSON body should not be parsed with malformed length");
      },
    });

    const response = await POST(request);

    expect(response.status).toBe(411);
    await expect(response.json()).resolves.toEqual({
      error: "Summary request requires a Content-Length header.",
    });
    expect(callOrder).toEqual([]);
  });
});

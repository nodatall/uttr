import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { POST } from "./route";
import { setDbExecutorForTests } from "@/lib/db";
import { resetRateLimitForTests } from "@/lib/rate-limit";
import {
  buildInstallTokenPayload,
  signInstallToken,
  type AnonymousTrialRow,
} from "@/lib/access";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  UTTR_INSTALL_TOKEN_SECRET: process.env.UTTR_INSTALL_TOKEN_SECRET,
  UTTR_CLAIM_TOKEN_SECRET: process.env.UTTR_CLAIM_TOKEN_SECRET,
  UTTR_DIAGNOSTICS_IDENTITY_SECRET:
    process.env.UTTR_DIAGNOSTICS_IDENTITY_SECRET,
  UTTR_DIAGNOSTICS_DISABLED: process.env.UTTR_DIAGNOSTICS_DISABLED,
};

function restoreEnv(name: keyof typeof originalEnv) {
  const value = originalEnv[name];
  if (typeof value === "string") {
    process.env[name] = value;
    return;
  }

  delete process.env[name];
}

const payload = {
  install_id: "install-test-123",
  app_version: "0.1.16",
  os_name: "macos",
  os_version_bucket: "15",
  feature: "transcription",
  provider: "byok_groq",
  model_id: "whisper-large-v3",
  event: "byok_transcription_failed",
  error_kind: "auth_failed",
  http_status: 401,
  latency_bucket: "1_3s",
  audio_duration_bucket: "5_15s",
};

function jsonRequest(body: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  return new Request("https://uttr.test/api/diagnostics/event", {
    method: "POST",
    body: text,
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(text).byteLength),
      "x-forwarded-for": "203.0.113.10",
      ...headers,
    },
  });
}

function trialRow(overrides: Partial<AnonymousTrialRow> = {}): AnonymousTrialRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    install_id: "token-install-id",
    device_fingerprint_hash: "fingerprint-123",
    user_id: "22222222-2222-4222-8222-222222222222",
    status: "trialing",
    trial_started_at: "2026-06-01T00:00:00.000Z",
    trial_ends_at: "2026-06-08T00:00:00.000Z",
    last_seen_at: "2026-06-01T00:00:00.000Z",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.UTTR_INSTALL_TOKEN_SECRET =
    "install-secret-test-with-enough-entropy";
  process.env.UTTR_CLAIM_TOKEN_SECRET =
    "claim-secret-test-with-enough-entropy";
  process.env.UTTR_DIAGNOSTICS_IDENTITY_SECRET =
    "diagnostic-secret-test-with-enough-entropy";
  delete process.env.UTTR_DIAGNOSTICS_DISABLED;
});

afterEach(() => {
  resetRateLimitForTests();
  setDbExecutorForTests(null);
  restoreEnv("NODE_ENV");
  restoreEnv("UTTR_INSTALL_TOKEN_SECRET");
  restoreEnv("UTTR_CLAIM_TOKEN_SECRET");
  restoreEnv("UTTR_DIAGNOSTICS_IDENTITY_SECRET");
  restoreEnv("UTTR_DIAGNOSTICS_DISABLED");
});

describe("diagnostics event route", () => {
  test("accepts valid anonymous events and does not store raw install id", async () => {
    const calls: { sql: string; values: readonly unknown[] }[] = [];
    setDbExecutorForTests({
      async query(sql, values = []) {
        calls.push({ sql, values });
        return { rows: [], rowCount: 1 };
      },
    });

    const response = await POST(jsonRequest(payload));

    expect(response.status).toBe(204);
    const insert = calls.find((call) =>
      call.sql.includes("insert into public.diagnostic_events"),
    );
    expect(insert).toBeDefined();
    expect(insert?.values[0]).not.toBe(payload.install_id);
    expect(String(insert?.values[0])).toHaveLength(64);
    expect(insert?.values).not.toContain(payload.install_id);
    expect(insert?.values[1]).toBeNull();
    expect(insert?.values[2]).toBeNull();
  });

  test("accepts valid token-derived identity", async () => {
    const calls: { sql: string; values: readonly unknown[] }[] = [];
    const tokenPayload = buildInstallTokenPayload({
      anonymousTrialId: "11111111-1111-4111-8111-111111111111",
      installId: "token-install-id",
      deviceFingerprintHash: "fingerprint-123",
    });
    const token = signInstallToken(tokenPayload);

    setDbExecutorForTests({
      async query(sql, values = []) {
        calls.push({ sql, values });
        if (sql.includes("from public.anonymous_trials")) {
          return { rows: [trialRow()], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
    });

    const response = await POST(
      jsonRequest(payload, { "install-token": token }),
    );

    expect(response.status).toBe(204);
    const insert = calls.find((call) =>
      call.sql.includes("insert into public.diagnostic_events"),
    );
    expect(insert?.values[1]).toBe("11111111-1111-4111-8111-111111111111");
    expect(String(insert?.values[2])).toHaveLength(64);
    expect(insert?.values).not.toContain("token-install-id");
  });

  test("rejects unknown fields and forbidden content keys", async () => {
    setDbExecutorForTests({
      async query() {
        return { rows: [], rowCount: 1 };
      },
    });

    const unknown = await POST(jsonRequest({ ...payload, arbitrary: "x" }));
    expect(unknown.status).toBe(400);

    const forbidden = await POST(
      jsonRequest({
        ...payload,
        transcript_text: "secret transcript",
        provider_response_body: "sk-test leaked",
      }),
    );
    expect(forbidden.status).toBe(400);
  });

  test("rejects invalid install tokens", async () => {
    setDbExecutorForTests({
      async query() {
        return { rows: [], rowCount: 1 };
      },
    });

    const response = await POST(
      jsonRequest(payload, { "install-token": "not-a-valid-token" }),
    );

    expect(response.status).toBe(401);
  });

  test("rejects oversized bodies and invalid enums", async () => {
    const oversized = await POST(
      new Request("https://uttr.test/api/diagnostics/event", {
        method: "POST",
        body: "{}",
        headers: {
          "content-type": "application/json",
          "content-length": String(16 * 1024 + 1),
        },
      }),
    );
    expect(oversized.status).toBe(413);

    const invalidEnum = await POST(
      jsonRequest({ ...payload, provider: "server_proxy" }),
    );
    expect(invalidEnum.status).toBe(400);
  });

  test("honors kill switch without storing events", async () => {
    process.env.UTTR_DIAGNOSTICS_DISABLED = "true";
    let queryCount = 0;
    setDbExecutorForTests({
      async query() {
        queryCount += 1;
        return { rows: [], rowCount: 1 };
      },
    });

    const response = await POST(jsonRequest(payload));

    expect(response.status).toBe(204);
    expect(queryCount).toBe(0);
  });

  test("rate limits by install identity", async () => {
    setDbExecutorForTests({
      async query() {
        return { rows: [], rowCount: 1 };
      },
    });

    for (let index = 0; index < 60; index += 1) {
      const response = await POST(jsonRequest(payload));
      expect(response.status).toBe(204);
    }

    const limited = await POST(jsonRequest(payload));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });
});

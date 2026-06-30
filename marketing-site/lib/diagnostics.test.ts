import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  hashDiagnosticIdentity,
  insertDiagnosticEvent,
  parseDiagnosticBody,
} from "./diagnostics";

const originalSecret = process.env.UTTR_DIAGNOSTICS_IDENTITY_SECRET;

beforeEach(() => {
  process.env.UTTR_DIAGNOSTICS_IDENTITY_SECRET =
    "diagnostic-secret-test-with-enough-entropy";
});

afterEach(() => {
  if (typeof originalSecret === "string") {
    process.env.UTTR_DIAGNOSTICS_IDENTITY_SECRET = originalSecret;
  } else {
    delete process.env.UTTR_DIAGNOSTICS_IDENTITY_SECRET;
  }
});

const payload = {
  install_id: "install-test-123",
  app_version: "0.1.16",
  os_name: "macos",
  os_version_bucket: "15",
  feature: "transcription",
  provider: "byok_openai",
  model_id: "gpt-4o-transcribe",
  event: "byok_transcription_failed",
  error_kind: "provider_5xx",
  http_status: 503,
  latency_bucket: "10_30s",
  audio_duration_bucket: "15_30s",
};

describe("diagnostics helpers", () => {
  test("hashes identities with the server secret", () => {
    const first = hashDiagnosticIdentity("install-a", "secret-a");
    const second = hashDiagnosticIdentity("install-a", "secret-b");

    expect(first).toHaveLength(64);
    expect(second).toHaveLength(64);
    expect(first).not.toBe(second);
  });

  test("rejects nested or arbitrary diagnostic metadata", () => {
    expect(() => parseDiagnosticBody(payload)).not.toThrow();
    expect(() =>
      parseDiagnosticBody({ ...payload, metadata: { transcript: "secret" } }),
    ).toThrow();
    expect(() =>
      parseDiagnosticBody({ ...payload, tags: ["provider", "failure"] }),
    ).toThrow();
  });

  test("inserts only sanitized scalar columns", async () => {
    let insertedValues: readonly unknown[] = [];
    await insertDiagnosticEvent(
      {
        ...payload,
        installId: "install-test-123",
        anonymousTrialId: null,
        userId: "user-test-123",
      },
      {
        async query(_sql, values = []) {
          insertedValues = values;
          return { rows: [], rowCount: 1 };
        },
      },
    );

    expect(insertedValues).not.toContain("install-test-123");
    expect(insertedValues).not.toContain("user-test-123");
    expect(String(insertedValues[0])).toHaveLength(64);
    expect(String(insertedValues[2])).toHaveLength(64);
  });
});

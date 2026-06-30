import { createHmac } from "node:crypto";
import { z } from "zod";
import { dbQuery, type DbExecutor } from "@/lib/db";
import { readDiagnosticsConfig } from "@/lib/env";

export const DIAGNOSTIC_BODY_LIMIT_BYTES = 16 * 1024;

export const diagnosticEventSchema = z
  .object({
    install_id: z.string().trim().min(8).max(128),
    app_version: z.string().trim().min(1).max(64),
    os_name: z.enum(["macos", "windows", "linux", "unknown"]),
    os_version_bucket: z.enum([
      "unknown",
      "pre_13",
      "13",
      "14",
      "15",
      "16_plus",
    ]),
    feature: z.enum(["transcription"]),
    provider: z.enum(["byok_groq", "byok_openai"]),
    model_id: z.enum([
      "whisper-large-v3",
      "whisper-large-v3-turbo",
      "gpt-4o-transcribe",
      "other",
    ]),
    event: z.enum(["byok_transcription_failed"]),
    error_kind: z.enum([
      "auth_failed",
      "rate_limited",
      "quota_exceeded",
      "provider_4xx",
      "provider_5xx",
      "timeout",
      "network_error",
      "parse_failed",
      "payload_too_large",
      "unsupported_feature",
      "missing_api_key",
      "request_failed",
      "unknown",
    ]),
    http_status: z.number().int().min(100).max(599).nullable(),
    latency_bucket: z.enum(["lt_1s", "1_3s", "3_10s", "10_30s", "30s_plus"]),
    audio_duration_bucket: z.enum([
      "0_5s",
      "5_15s",
      "15_30s",
      "30_60s",
      "60s_plus",
    ]),
  })
  .strict();

export type DiagnosticEventPayload = z.infer<typeof diagnosticEventSchema>;

export type DiagnosticIdentity = {
  installId: string;
  anonymousTrialId: string | null;
  userId: string | null;
};

export type DiagnosticEventInsert = Omit<DiagnosticEventPayload, "install_id"> &
  DiagnosticIdentity;

export function hashDiagnosticIdentity(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function parseDiagnosticBody(body: unknown): DiagnosticEventPayload {
  return diagnosticEventSchema.parse(body);
}

export async function insertDiagnosticEvent(
  row: DiagnosticEventInsert,
  executor: DbExecutor = { query: dbQuery },
) {
  const { identitySecret } = readDiagnosticsConfig();
  const installIdHash = hashDiagnosticIdentity(row.installId, identitySecret);
  const userIdHash = row.userId
    ? hashDiagnosticIdentity(row.userId, identitySecret)
    : null;

  await executor.query(
    `insert into public.diagnostic_events (
       install_id_hash,
       anonymous_trial_id,
       user_id_hash,
       app_version,
       os_name,
       os_version_bucket,
       feature,
       provider,
       model_id,
       event,
       error_kind,
       http_status,
       latency_bucket,
       audio_duration_bucket
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      installIdHash,
      row.anonymousTrialId,
      userIdHash,
      row.app_version,
      row.os_name,
      row.os_version_bucket,
      row.feature,
      row.provider,
      row.model_id,
      row.event,
      row.error_kind,
      row.http_status,
      row.latency_bucket,
      row.audio_duration_bucket,
    ],
  );

  return { installIdHash, userIdHash };
}

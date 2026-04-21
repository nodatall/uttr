import { NextResponse } from "next/server";
import { performance } from "node:perf_hooks";
import {
  estimateAudioSecondsFromWavBytes,
  isGroqUploadWithinLimit,
  summarizeGroqPayload,
  transcribeWithGroq,
} from "@/lib/groq";
import { buildTimings } from "@/lib/groq/timings";
import {
  fetchAnonymousTrialById,
  fetchEntitlementByUserId,
  fetchUsageEventsSince,
  insertUsageEvent,
  patchAnonymousTrialById,
  readInstallTokenFromRequest,
  refreshAnonymousTrialState,
  resolveAccessDecision,
  type InstallTokenPayload,
  type UsageEventRow,
  verifyInstallToken,
} from "@/lib/access";
import { evaluateCloudTranscriptionPreflight } from "@/lib/access/cloud-transcription-policy";
import {
  checkRateLimit,
  rateLimitKeyFromRequest,
  type RateLimitBlockedDecision,
  resolveRateLimitFailure,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TRIAL_DURATION_MS = 48 * 60 * 60 * 1000;

function parseBooleanField(value: FormDataEntryValue | null) {
  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function parseTextField(value: FormDataEntryValue | null) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseChunkNumberField(value: FormDataEntryValue | null) {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isFileEntry(value: FormDataEntryValue | null): value is File {
  return typeof File !== "undefined" && value instanceof File;
}

function respondToRateLimit(
  rateLimit: RateLimitBlockedDecision,
  exhaustedMessage: string,
) {
  const failure = resolveRateLimitFailure(rateLimit, exhaustedMessage);

  return NextResponse.json(
    { error: failure.error },
    {
      status: failure.status,
      headers: {
        "retry-after": String(failure.retryAfterSeconds),
      },
    },
  );
}

function resolvePostTranscriptionAccessState(
  trialState: string,
  accessState: string,
) {
  return trialState === "trialing" ? "trialing" : accessState;
}

export async function POST(request: Request) {
  const startMs = performance.now();

  try {
    const rateLimit = await checkRateLimit({
      key: rateLimitKeyFromRequest(request, "cloud-transcribe"),
      limit: 60,
      windowMs: 60_000,
    });
    if (!rateLimit.allowed) {
      return respondToRateLimit(rateLimit, "Too many transcription requests.");
    }

    const installToken = readInstallTokenFromRequest(request);
    if (!installToken) {
      return NextResponse.json(
        { error: "Missing install token." },
        { status: 400 },
      );
    }

    let tokenPayload: InstallTokenPayload;
    try {
      tokenPayload = verifyInstallToken(installToken);
    } catch (error) {
      return NextResponse.json(
        {
          error:
            error instanceof Error ? error.message : "Invalid install token.",
        },
        { status: 401 },
      );
    }

    const trial = await fetchAnonymousTrialById(
      tokenPayload.anonymous_trial_id,
    );
    if (
      !trial ||
      trial.install_id !== tokenPayload.install_id ||
      trial.device_fingerprint_hash !== tokenPayload.device_fingerprint_hash
    ) {
      return NextResponse.json(
        { error: "Invalid install token." },
        { status: 401 },
      );
    }

    const refreshedTrial = await refreshAnonymousTrialState(trial);
    const entitlement = refreshedTrial.user_id
      ? await fetchEntitlementByUserId(refreshedTrial.user_id)
      : null;
    const accessDecision = resolveAccessDecision(refreshedTrial, entitlement);

    if (
      accessDecision.accessState === "blocked" &&
      refreshedTrial.status !== "new"
    ) {
      return NextResponse.json(
        { error: "Transcription access is blocked." },
        { status: 403 },
      );
    }

    const formData = await request.formData();
    const fileEntry = formData.get("file");

    if (!isFileEntry(fileEntry)) {
      return NextResponse.json(
        { error: "Missing audio file." },
        { status: 400 },
      );
    }

    if (!isGroqUploadWithinLimit(fileEntry.size)) {
      return NextResponse.json(
        { error: "Audio upload exceeds the 100 MB limit." },
        { status: 413 },
      );
    }

    const translateToEnglish = parseBooleanField(
      formData.get("translate_to_english"),
    );
    const source = parseTextField(formData.get("source"));
    const chunkIndex = parseChunkNumberField(formData.get("chunk_index"));
    const chunkCount = parseChunkNumberField(formData.get("chunk_count"));
    const audioSeconds =
      parseChunkNumberField(formData.get("audio_seconds")) ??
      estimateAudioSecondsFromWavBytes(fileEntry.size);

    const requestedModel = parseTextField(formData.get("model"));
    const groqTraceId = summarizeGroqPayload(
      fileEntry.name || "uttr.wav",
      requestedModel || "default",
    );

    let usageEvents: UsageEventRow[] = [];
    if (accessDecision.accessState !== "subscribed") {
      const usageWindowStart =
        refreshedTrial.trial_started_at ||
        new Date(Date.now() - TRIAL_DURATION_MS).toISOString();
      usageEvents = await fetchUsageEventsSince({
        anonymousTrialId: refreshedTrial.id,
        since: usageWindowStart,
      });
    }

    const preflightDecision = evaluateCloudTranscriptionPreflight({
      accessState: accessDecision.accessState,
      trialState: accessDecision.trialState,
      source,
      usageEvents,
      audioSeconds,
    });
    if (!preflightDecision.allowed) {
      return NextResponse.json(
        {
          error: preflightDecision.error,
          reason: preflightDecision.reason,
        },
        { status: preflightDecision.status },
      );
    }

    const now = new Date().toISOString();
    let persistedTrial = refreshedTrial;

    if (
      refreshedTrial.status === "new" &&
      accessDecision.accessState !== "subscribed"
    ) {
      const startedTrial = await patchAnonymousTrialById(refreshedTrial.id, {
        status: "trialing",
        trial_started_at: now,
        trial_ends_at: new Date(Date.now() + TRIAL_DURATION_MS).toISOString(),
        last_seen_at: now,
      });

      if (!startedTrial) {
        throw new Error("Unable to start anonymous trial.");
      }

      persistedTrial = startedTrial;
    } else {
      const touchedTrial = await patchAnonymousTrialById(refreshedTrial.id, {
        last_seen_at: now,
      });

      if (!touchedTrial) {
        throw new Error("Unable to refresh trial heartbeat.");
      }

      persistedTrial = touchedTrial;
    }

    const fileBytes = Buffer.from(await fileEntry.arrayBuffer());
    const groqStartMs = performance.now();
    const groqResult = await transcribeWithGroq({
      audioBytes: fileBytes,
      fileName: fileEntry.name || "uttr.wav",
      mimeType: fileEntry.type || "audio/wav",
      language: parseTextField(formData.get("language")),
      model: requestedModel,
      translateToEnglish,
    });
    const groqEndMs = performance.now();

    const usageEvent = await insertUsageEvent({
      anonymous_trial_id: persistedTrial.id,
      user_id: persistedTrial.user_id,
      source: "cloud_default",
      audio_seconds: audioSeconds,
    });

    if (!usageEvent) {
      throw new Error("Unable to record usage event.");
    }

    const endMs = performance.now();

    const timings = buildTimings(startMs, groqStartMs, groqEndMs, endMs);
    const accessState = resolvePostTranscriptionAccessState(
      persistedTrial.status,
      accessDecision.accessState,
    );

    console.info(
      JSON.stringify({
        level: "info",
        event: "cloud_transcription_completed",
        trace_id: groqTraceId,
        source,
        chunk_index: chunkIndex,
        chunk_count: chunkCount,
        trial_id: persistedTrial.id,
        trial_state: persistedTrial.status,
        access_state: accessState,
        groq_endpoint: groqResult.endpoint,
        groq_model: groqResult.model,
        timings,
      }),
    );

    return NextResponse.json({
      text: groqResult.text,
      timings,
      trial_state: persistedTrial.status,
      access_state: accessState,
      entitlement_state: accessDecision.entitlementState,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "cloud_transcription_failed",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );

    return NextResponse.json(
      { error: "Could not transcribe audio." },
      { status: 500 },
    );
  }
}

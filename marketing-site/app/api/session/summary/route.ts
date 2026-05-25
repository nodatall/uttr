import { NextResponse } from "next/server";
import { performance } from "node:perf_hooks";
import type { DbExecutor } from "@/lib/db";
import {
  fetchAnonymousTrialById,
  fetchEntitlementByUserId,
  patchAnonymousTrialById,
  readInstallTokenFromRequest,
  refreshAnonymousTrialState,
  resolveAccessDecision,
  type InstallTokenPayload,
  verifyInstallToken,
  withAnonymousTrialUsageLock,
  withUserUsageLock,
} from "@/lib/access";
import { summarizeSessionWithOpenAi } from "@/lib/openai/session-summary";
import {
  checkRateLimit,
  rateLimitKeyFromRequest,
  type RateLimitBlockedDecision,
  resolveRateLimitFailure,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TRIAL_DURATION_MS = 48 * 60 * 60 * 1000;
const SUMMARY_REQUEST_BODY_LIMIT_BYTES = 512 * 1024;
const SUMMARY_PRINCIPAL_RATE_LIMIT = 120;
const SUMMARY_PRINCIPAL_RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_TRANSCRIPT_CHARS = 80_000;
const MAX_PREVIOUS_SUMMARY_CHARS = 12_000;

interface SummaryRequestBody {
  transcript_text?: unknown;
  previous_summary?: unknown;
  chunk_count?: unknown;
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

function principalRateLimitKey(params: {
  anonymousTrialId: string;
  userId: string | null;
}) {
  return params.userId
    ? `summary-principal:user:${params.userId}`
    : `summary-principal:trial:${params.anonymousTrialId}`;
}

function requestBodyIsClearlyTooLarge(request: Request) {
  const contentLength = request.headers.get("content-length");
  if (!contentLength || !/^\d+$/.test(contentLength)) {
    return false;
  }

  const parsed = Number.parseInt(contentLength, 10);
  return Number.isFinite(parsed) && parsed > SUMMARY_REQUEST_BODY_LIMIT_BYTES;
}

async function readJsonPayload(request: Request) {
  try {
    return (await request.json()) as SummaryRequestBody;
  } catch {
    return null;
  }
}

function textField(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function optionalTextField(value: unknown) {
  const text = textField(value);
  return text ? text : null;
}

function numericField(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }
  return 0;
}

function resolvePostSummaryAccessState(
  trialState: string,
  accessState: string,
) {
  return trialState === "trialing" ? "trialing" : accessState;
}

export async function POST(request: Request) {
  const startMs = performance.now();

  try {
    const rateLimit = await checkRateLimit({
      key: rateLimitKeyFromRequest(request, "session-summary"),
      limit: 60,
      windowMs: 60_000,
    });
    if (!rateLimit.allowed) {
      return respondToRateLimit(rateLimit, "Too many summary requests.");
    }

    if (requestBodyIsClearlyTooLarge(request)) {
      return NextResponse.json(
        { error: "Summary request exceeds the 512 KB limit." },
        { status: 413 },
      );
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

    const payload = await readJsonPayload(request);
    if (!payload) {
      return NextResponse.json(
        { error: "Invalid summary request body." },
        { status: 400 },
      );
    }

    const transcriptText = textField(payload.transcript_text);
    if (!transcriptText) {
      return NextResponse.json(
        { error: "Missing transcript text." },
        { status: 400 },
      );
    }

    if (transcriptText.length > MAX_TRANSCRIPT_CHARS) {
      return NextResponse.json(
        { error: "Transcript is too long to summarize in one request." },
        { status: 413 },
      );
    }

    const previousSummary = optionalTextField(payload.previous_summary);
    if (
      previousSummary &&
      previousSummary.length > MAX_PREVIOUS_SUMMARY_CHARS
    ) {
      return NextResponse.json(
        { error: "Previous summary is too long." },
        { status: 413 },
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

    const principalRateLimit = await checkRateLimit({
      key: principalRateLimitKey({
        anonymousTrialId: refreshedTrial.id,
        userId: refreshedTrial.user_id,
      }),
      limit: SUMMARY_PRINCIPAL_RATE_LIMIT,
      windowMs: SUMMARY_PRINCIPAL_RATE_LIMIT_WINDOW_MS,
    });
    if (!principalRateLimit.allowed) {
      return respondToRateLimit(
        principalRateLimit,
        "Too many summary requests for this install.",
      );
    }

    if (
      accessDecision.accessState === "blocked" &&
      refreshedTrial.status !== "new"
    ) {
      return NextResponse.json(
        { error: "Summary access is blocked." },
        { status: 403 },
      );
    }

    const runSummary = async (executor?: DbExecutor) => {
      const now = new Date().toISOString();
      let persistedTrial = refreshedTrial;

      if (
        refreshedTrial.status === "new" &&
        accessDecision.accessState !== "subscribed"
      ) {
        const startedTrial = await patchAnonymousTrialById(
          refreshedTrial.id,
          {
            status: "trialing",
            trial_started_at: now,
            trial_ends_at: new Date(
              Date.now() + TRIAL_DURATION_MS,
            ).toISOString(),
            last_seen_at: now,
          },
          executor,
        );

        if (!startedTrial) {
          throw new Error("Unable to start anonymous trial.");
        }

        persistedTrial = startedTrial;
      } else {
        const touchedTrial = await patchAnonymousTrialById(
          refreshedTrial.id,
          {
            last_seen_at: now,
          },
          executor,
        );

        if (!touchedTrial) {
          throw new Error("Unable to refresh trial heartbeat.");
        }

        persistedTrial = touchedTrial;
      }

      const summary = await summarizeSessionWithOpenAi({
        transcriptText,
        previousSummary,
      });
      const accessState = resolvePostSummaryAccessState(
        persistedTrial.status,
        accessDecision.accessState,
      );

      console.info(
        JSON.stringify({
          level: "info",
          event: "cloud_summary_completed",
          trial_id: persistedTrial.id,
          trial_state: persistedTrial.status,
          access_state: accessState,
          chunk_count: numericField(payload.chunk_count),
          transcript_chars: transcriptText.length,
          elapsed_ms: Math.round(performance.now() - startMs),
        }),
      );

      return NextResponse.json({
        summary,
        trial_state: persistedTrial.status,
        access_state: accessState,
        entitlement_state: accessDecision.entitlementState,
      });
    };

    if (accessDecision.accessState === "subscribed") {
      if (!refreshedTrial.user_id) {
        throw new Error("Subscribed access is missing a linked user.");
      }

      return await withUserUsageLock(refreshedTrial.user_id, runSummary);
    }

    return await withAnonymousTrialUsageLock(refreshedTrial.id, runSummary);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "cloud_summary_failed",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );

    return NextResponse.json(
      { error: "Could not summarize session." },
      { status: 500 },
    );
  }
}

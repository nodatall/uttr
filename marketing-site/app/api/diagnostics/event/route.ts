import { NextResponse } from "next/server";
import {
  fetchAnonymousTrialById,
  readInstallTokenFromRequest,
  verifyInstallToken,
  type InstallTokenPayload,
} from "@/lib/access";
import {
  DIAGNOSTIC_BODY_LIMIT_BYTES,
  hashDiagnosticIdentity,
  insertDiagnosticEvent,
  parseDiagnosticBody,
} from "@/lib/diagnostics";
import { readDiagnosticsConfig } from "@/lib/env";
import {
  checkRateLimit,
  rateLimitKeyFromRequest,
  resolveRateLimitFailure,
  type RateLimitBlockedDecision,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DIAGNOSTIC_IP_RATE_LIMIT = 120;
const DIAGNOSTIC_INSTALL_RATE_LIMIT = 60;
const DIAGNOSTIC_RATE_LIMIT_WINDOW_MS = 60_000;

function requestBodyIsClearlyTooLarge(request: Request) {
  const contentLength = request.headers.get("content-length");
  if (!contentLength || !/^\d+$/.test(contentLength)) {
    return false;
  }

  const parsed = Number.parseInt(contentLength, 10);
  return Number.isFinite(parsed) && parsed > DIAGNOSTIC_BODY_LIMIT_BYTES;
}

async function readJsonBody(request: Request) {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > DIAGNOSTIC_BODY_LIMIT_BYTES) {
    return { ok: false as const, status: 413, error: "Diagnostic event is too large." };
  }

  try {
    return { ok: true as const, body: JSON.parse(raw) };
  } catch {
    return { ok: false as const, status: 400, error: "Invalid diagnostic event." };
  }
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

async function resolveTokenIdentity(
  request: Request,
): Promise<
  | { ok: true; anonymousTrialId: string | null; userId: string | null; installId: string | null }
  | { ok: false }
> {
  const installToken = readInstallTokenFromRequest(request);
  if (!installToken) {
    return { ok: true, anonymousTrialId: null, userId: null, installId: null };
  }

  let tokenPayload: InstallTokenPayload;
  try {
    tokenPayload = verifyInstallToken(installToken);
  } catch {
    return { ok: false };
  }

  const trial = await fetchAnonymousTrialById(tokenPayload.anonymous_trial_id);
  if (
    !trial ||
    trial.install_id !== tokenPayload.install_id ||
    trial.device_fingerprint_hash !== tokenPayload.device_fingerprint_hash
  ) {
    return { ok: false };
  }

  return {
    ok: true,
    anonymousTrialId: trial.id,
    userId: trial.user_id,
    installId: trial.install_id,
  };
}

export async function POST(request: Request) {
  try {
    const config = readDiagnosticsConfig();
    if (config.disabled) {
      return new Response(null, { status: 204 });
    }

    const ipRateLimit = await checkRateLimit({
      key: rateLimitKeyFromRequest(request, "diagnostics-event"),
      limit: DIAGNOSTIC_IP_RATE_LIMIT,
      windowMs: DIAGNOSTIC_RATE_LIMIT_WINDOW_MS,
    });
    if (!ipRateLimit.allowed) {
      return respondToRateLimit(ipRateLimit, "Too many diagnostic events.");
    }

    if (requestBodyIsClearlyTooLarge(request)) {
      return NextResponse.json(
        { error: "Diagnostic event is too large." },
        { status: 413 },
      );
    }

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return NextResponse.json(
        { error: "Diagnostic event must be JSON." },
        { status: 415 },
      );
    }

    const parsedBody = await readJsonBody(request);
    if (!parsedBody.ok) {
      return NextResponse.json(
        { error: parsedBody.error },
        { status: parsedBody.status },
      );
    }

    const payload = parseDiagnosticBody(parsedBody.body);
    const tokenIdentity = await resolveTokenIdentity(request);
    if (!tokenIdentity.ok) {
      return NextResponse.json(
        { error: "Invalid install token." },
        { status: 401 },
      );
    }

    const installId = tokenIdentity.installId ?? payload.install_id;
    const installIdHash = hashDiagnosticIdentity(installId, config.identitySecret);
    const principalRateLimit = await checkRateLimit({
      key: `diagnostics-event-install:${installIdHash}`,
      limit: DIAGNOSTIC_INSTALL_RATE_LIMIT,
      windowMs: DIAGNOSTIC_RATE_LIMIT_WINDOW_MS,
    });
    if (!principalRateLimit.allowed) {
      return respondToRateLimit(
        principalRateLimit,
        "Too many diagnostic events for this install.",
      );
    }

    await insertDiagnosticEvent({
      ...payload,
      installId,
      anonymousTrialId: tokenIdentity.anonymousTrialId,
      userId: tokenIdentity.userId,
    });

    return new Response(null, { status: 204 });
  } catch (error) {
    const validationError =
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "ZodError";

    if (validationError) {
      return NextResponse.json(
        { error: "Invalid diagnostic event." },
        { status: 400 },
      );
    }

    console.error(
      JSON.stringify({
        level: "error",
        event: "diagnostic_event_failed",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );

    return NextResponse.json(
      { error: "Could not store diagnostic event." },
      { status: 500 },
    );
  }
}

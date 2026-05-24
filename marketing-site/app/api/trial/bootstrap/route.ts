import { NextResponse } from "next/server";
import { z } from "zod";
import {
  fetchEntitlementByUserId,
  refreshAnonymousTrialState,
  resolveAccessDecision,
  buildInstallTokenPayload,
  signInstallToken,
  upsertAnonymousTrialHeartbeat,
} from "@/lib/access";
import {
  checkRateLimit,
  rateLimitKeyFromRequest,
  type RateLimitBlockedDecision,
  resolveRateLimitFailure,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  install_id: z.string().min(1).max(200),
  device_fingerprint_hash: z.string().min(1).max(200),
  app_version: z.string().min(1).max(100),
});

async function readJsonPayload(request: Request) {
  return request.json().catch(() => ({}));
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

export async function POST(request: Request) {
  try {
    const rateLimit = await checkRateLimit({
      key: rateLimitKeyFromRequest(request, "trial-bootstrap"),
      limit: 30,
      windowMs: 60_000,
    });
    if (!rateLimit.allowed) {
      return respondToRateLimit(
        rateLimit,
        "Too many trial bootstrap requests.",
      );
    }

    const parsedBody = requestSchema.safeParse(await readJsonPayload(request));
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: "Invalid bootstrap payload." },
        { status: 400 },
      );
    }

    const now = new Date().toISOString();
    const trial = await upsertAnonymousTrialHeartbeat({
      installId: parsedBody.data.install_id,
      deviceFingerprintHash: parsedBody.data.device_fingerprint_hash,
      lastSeenAt: now,
    });

    if (!trial) {
      return NextResponse.json(
        { error: "Unable to create trial state." },
        { status: 500 },
      );
    }

    const refreshedTrial = await refreshAnonymousTrialState(trial);
    const entitlement = refreshedTrial.user_id
      ? await fetchEntitlementByUserId(refreshedTrial.user_id)
      : null;
    const accessDecision = resolveAccessDecision(refreshedTrial, entitlement);
    const installTokenPayload = buildInstallTokenPayload({
      anonymousTrialId: refreshedTrial.id,
      installId: refreshedTrial.install_id,
      deviceFingerprintHash: refreshedTrial.device_fingerprint_hash,
      issuedAt: new Date(now),
    });
    const installToken = signInstallToken(installTokenPayload);

    return NextResponse.json({
      trial_state: accessDecision.trialState,
      access_state: accessDecision.accessState,
      install_token: installToken,
      install_token_expires_at: installTokenPayload.expires_at,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "trial_bootstrap_failed",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );

    return NextResponse.json(
      { error: "Could not bootstrap install state." },
      { status: 500 },
    );
  }
}

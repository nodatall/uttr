import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  fetchAnonymousTrialById,
  fetchEntitlementByUserId,
  hashClaimToken,
  insertTrialClaim,
  patchAnonymousTrialById,
  readInstallTokenFromRequest,
  refreshAnonymousTrialState,
  resolveAccessDecision,
  signClaimToken,
  type InstallTokenPayload,
  verifyInstallToken,
} from "@/lib/access";
import { trialCanCreateClaim } from "@/lib/access/claim-eligibility";
import { readSiteConfig } from "@/lib/env";
import {
  checkRateLimit,
  rateLimitKeyFromRequest,
  type RateLimitBlockedDecision,
  resolveRateLimitFailure,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  install_token: z.string().min(1).max(4096).optional(),
});

const CLAIM_TTL_MS = 15 * 60 * 1000;

function buildClaimUrl(claimToken: string) {
  const { siteUrl } = readSiteConfig();
  const url = new URL("/claim", siteUrl);
  url.searchParams.set("claim_token", claimToken);
  return url.toString();
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

async function readInstallTokenFromBodyOrRequest(request: Request) {
  const transportToken = readInstallTokenFromRequest(request);
  if (transportToken) {
    return transportToken;
  }

  const parsedBody = requestSchema.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsedBody.success) {
    return null;
  }

  return parsedBody.data.install_token ?? null;
}

export async function POST(request: Request) {
  try {
    const rateLimit = await checkRateLimit({
      key: rateLimitKeyFromRequest(request, "trial-create-claim"),
      limit: 20,
      windowMs: 60_000,
    });
    if (!rateLimit.allowed) {
      return respondToRateLimit(rateLimit, "Too many claim requests.");
    }

    const installToken = await readInstallTokenFromBodyOrRequest(request);
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

    if (!trialCanCreateClaim(refreshedTrial, accessDecision)) {
      return NextResponse.json(
        {
          error: "Claim tokens are only available for non-active installs.",
        },
        { status: 409 },
      );
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + CLAIM_TTL_MS).toISOString();
    const claimTokenPayload = {
      version: 1 as const,
      claim_id: randomUUID(),
      anonymous_trial_id: refreshedTrial.id,
      install_id: refreshedTrial.install_id,
      issued_at: now.toISOString(),
      expires_at: expiresAt,
    };
    const claimToken = signClaimToken(claimTokenPayload);
    const claimTokenHash = hashClaimToken(claimToken);

    const insertedClaim = await insertTrialClaim({
      id: claimTokenPayload.claim_id,
      anonymous_trial_id: claimTokenPayload.anonymous_trial_id,
      claim_token_hash: claimTokenHash,
      expires_at: claimTokenPayload.expires_at,
    });

    if (!insertedClaim) {
      throw new Error("Unable to create claim token.");
    }

    const touchedTrial = await patchAnonymousTrialById(refreshedTrial.id, {
      last_seen_at: now.toISOString(),
    });
    if (!touchedTrial) {
      throw new Error("Unable to refresh trial heartbeat.");
    }

    return NextResponse.json({
      claim_token: claimToken,
      claim_url: buildClaimUrl(claimToken),
      expires_at: expiresAt,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "claim_token_create_failed",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );

    return NextResponse.json(
      { error: "Could not create claim token." },
      { status: 500 },
    );
  }
}

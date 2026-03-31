import { NextResponse } from "next/server";
import { z } from "zod";
import {
  fetchAnonymousTrialById,
  fetchEntitlementByUserId,
  fetchSupabaseUser,
  fetchTrialClaimByHash,
  hashClaimToken,
  readSupabaseAccessTokenFromRequest,
  redeemTrialClaim,
  type ClaimTokenPayload,
  verifyClaimToken,
} from "@/lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  claim_token: z.string().min(1).max(4096),
});

function isExpired(expiresAt: string) {
  return new Date(expiresAt).getTime() <= Date.now();
}

function isRedeemableClaim(payload: ClaimTokenPayload, claimExpiresAt: string) {
  return !isExpired(payload.expires_at) && !isExpired(claimExpiresAt);
}

export async function POST(request: Request) {
  try {
    const parsedBody = requestSchema.safeParse(await request.json());
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: "Invalid conversion payload." },
        { status: 400 },
      );
    }

    const accessToken = readSupabaseAccessTokenFromRequest(request);
    if (!accessToken) {
      return NextResponse.json(
        { error: "Missing Supabase access token." },
        { status: 401 },
      );
    }

    const currentUser = await fetchSupabaseUser(accessToken);

    let tokenPayload: ClaimTokenPayload;
    try {
      tokenPayload = verifyClaimToken(parsedBody.data.claim_token);
    } catch (error) {
      return NextResponse.json(
        {
          error:
            error instanceof Error ? error.message : "Invalid claim token.",
        },
        { status: 401 },
      );
    }

    const claimTokenHash = hashClaimToken(parsedBody.data.claim_token);
    const claim = await fetchTrialClaimByHash(claimTokenHash);
    if (!claim) {
      return NextResponse.json(
        { error: "Claim token not found." },
        { status: 404 },
      );
    }

    if (
      claim.id !== tokenPayload.claim_id ||
      claim.anonymous_trial_id !== tokenPayload.anonymous_trial_id
    ) {
      return NextResponse.json(
        { error: "Claim token payload mismatch." },
        { status: 409 },
      );
    }

    if (!isRedeemableClaim(tokenPayload, claim.expires_at)) {
      return NextResponse.json(
        { error: "Claim token expired." },
        { status: 409 },
      );
    }

    if (claim.redeemed_at) {
      return NextResponse.json(
        { error: "Claim token already redeemed." },
        { status: 409 },
      );
    }

    const trial = await fetchAnonymousTrialById(claim.anonymous_trial_id);
    if (
      !trial ||
      trial.install_id !== tokenPayload.install_id ||
      trial.user_id
    ) {
      return NextResponse.json(
        { error: "Anonymous trial is no longer eligible for claim redemption." },
        { status: 409 },
      );
    }

    const linkedTrial = await redeemTrialClaim({
      claimTokenHash,
      userId: currentUser.id,
    });

    const entitlement = await fetchEntitlementByUserId(currentUser.id);

    return NextResponse.json({
      linked: true,
      user_id: linkedTrial.user_id || currentUser.id,
      has_active_entitlement:
        entitlement?.subscription_status === "active",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      message.includes("already redeemed") || message.includes("different user")
        ? 409
        : 500;

    console.error(
      JSON.stringify({
        level: "error",
        event: "anonymous_conversion_failed",
        message,
      }),
    );

    return NextResponse.json(
      { error: "Could not link anonymous install." },
      { status },
    );
  }
}

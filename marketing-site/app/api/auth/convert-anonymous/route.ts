import { NextResponse } from "next/server";
import { z } from "zod";
import {
  fetchAnonymousTrialById,
  fetchEntitlementByUserId,
  fetchAuthenticatedUser,
  fetchTrialClaimByHash,
  hashClaimToken,
  readAccessTokenFromRequest,
  redeemTrialClaim,
  type ClaimTokenPayload,
  verifyClaimToken,
} from "@/lib/access";
import {
  resolveClaimConversionOutcome,
  type ClaimConversionStatus,
} from "@/lib/access/claim-conversion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  claim_token: z.string().min(1).max(4096),
});

function claimConversionStatusCode(status: ClaimConversionStatus) {
  switch (status) {
    case "linked":
    case "already_linked_same_user":
      return 200;
    case "already_linked_different_user":
      return 403;
    case "expired_claim":
      return 410;
    case "invalid_claim":
      return 404;
  }
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

    const accessToken = readAccessTokenFromRequest(request);
    if (!accessToken) {
      return NextResponse.json({ error: "Missing session." }, { status: 401 });
    }

    let currentUser;
    try {
      currentUser = await fetchAuthenticatedUser(accessToken);
    } catch {
      return NextResponse.json(
        { error: "Invalid or expired session." },
        { status: 401 },
      );
    }

    let tokenPayload: ClaimTokenPayload;
    try {
      tokenPayload = verifyClaimToken(parsedBody.data.claim_token);
    } catch (error) {
      return NextResponse.json(
        {
          status: "invalid_claim",
          checkout_safe: false,
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
        {
          status: "invalid_claim",
          checkout_safe: false,
          error: "Claim token not found.",
        },
        { status: 404 },
      );
    }

    if (
      claim.id !== tokenPayload.claim_id ||
      claim.anonymous_trial_id !== tokenPayload.anonymous_trial_id
    ) {
      return NextResponse.json(
        {
          status: "invalid_claim",
          checkout_safe: false,
          error: "Claim token payload mismatch.",
        },
        { status: 404 },
      );
    }

    const trial = await fetchAnonymousTrialById(claim.anonymous_trial_id);
    const entitlement = await fetchEntitlementByUserId(currentUser.id);
    const outcome = resolveClaimConversionOutcome({
      currentUserId: currentUser.id,
      tokenPayload,
      claim,
      trial,
      entitlement,
    });

    if (outcome.status === "linked") {
      const linkedTrial = await redeemTrialClaim({
        claimTokenHash,
        userId: currentUser.id,
      });

      return NextResponse.json({
        ...outcome,
        user_id: linkedTrial.user_id || currentUser.id,
      });
    }

    return NextResponse.json(outcome, {
      status: claimConversionStatusCode(outcome.status),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    console.error(
      JSON.stringify({
        level: "error",
        event: "anonymous_conversion_failed",
        message,
      }),
    );

    return NextResponse.json(
      { error: "Could not link anonymous install." },
      { status: 500 },
    );
  }
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { checkoutRequiresClaimToken } from "@/lib/checkout-policy";
import {
  fetchAnonymousTrialById,
  fetchEntitlementByUserId,
  fetchAuthenticatedUser,
  fetchTrialClaimByHash,
  hashClaimToken,
  readAccessTokenFromRequest,
  type ClaimTokenPayload,
  verifyClaimToken,
} from "@/lib/access";
import { createOrReuseCheckoutSession } from "@/lib/checkout";
import { readCheckoutConfig } from "@/lib/env";
import {
  checkRateLimit,
  rateLimitKeyFromRequest,
  resolveRateLimitFailure,
  type RateLimitBlockedDecision,
} from "@/lib/rate-limit";
import { getStripe } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  claim_token: z.string().min(1).max(4096).optional(),
  source: z.string().max(120).optional(),
});

function normalizeSource(source: string | undefined) {
  return source?.trim() || "direct";
}

function respondToRateLimit(rateLimit: RateLimitBlockedDecision) {
  const failure = resolveRateLimitFailure(
    rateLimit,
    "Too many checkout requests.",
  );

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

class CheckoutRouteError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function resolveClaimContext(claimToken: string, userId: string) {
  let tokenPayload: ClaimTokenPayload;
  try {
    tokenPayload = verifyClaimToken(claimToken);
  } catch (error) {
    throw new CheckoutRouteError(
      401,
      error instanceof Error ? error.message : "Invalid claim token.",
    );
  }

  const claimTokenHash = hashClaimToken(claimToken);
  const claim = await fetchTrialClaimByHash(claimTokenHash);
  if (!claim) {
    throw new CheckoutRouteError(404, "Claim token not found.");
  }

  if (
    claim.id !== tokenPayload.claim_id ||
    claim.anonymous_trial_id !== tokenPayload.anonymous_trial_id ||
    claimTokenHash !== claim.claim_token_hash
  ) {
    throw new CheckoutRouteError(409, "Claim token payload mismatch.");
  }

  if (new Date(claim.expires_at).getTime() <= Date.now()) {
    throw new CheckoutRouteError(409, "Claim token expired.");
  }

  if (!claim.redeemed_at) {
    throw new CheckoutRouteError(
      409,
      "Claim token must be redeemed before checkout.",
    );
  }

  const trial = await fetchAnonymousTrialById(claim.anonymous_trial_id);
  if (!trial || trial.install_id !== tokenPayload.install_id) {
    throw new CheckoutRouteError(409, "Claim token is no longer valid.");
  }

  if (trial.user_id !== userId) {
    throw new CheckoutRouteError(
      409,
      "Claim token is linked to a different user.",
    );
  }

  return {
    anonymousTrialId: trial.id,
    installId: trial.install_id,
  };
}

export async function POST(request: Request) {
  try {
    const rateLimit = await checkRateLimit({
      key: rateLimitKeyFromRequest(request, "checkout"),
      limit: 20,
      windowMs: 60_000,
    });
    if (!rateLimit.allowed) {
      return respondToRateLimit(rateLimit);
    }

    const parsedBody = requestSchema.safeParse(await request.json());
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: "Invalid checkout payload." },
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
    if (!currentUser.email) {
      return NextResponse.json(
        { error: "Authenticated user is missing an email address." },
        { status: 400 },
      );
    }

    const { stripeSecretKey, monthlyPriceId, siteUrl } = readCheckoutConfig();
    const stripe = getStripe(stripeSecretKey);
    const source = normalizeSource(parsedBody.data.source);
    const entitlement = await fetchEntitlementByUserId(currentUser.id);
    const hasActiveEntitlement = entitlement?.subscription_status === "active";

    if (hasActiveEntitlement) {
      return NextResponse.json({
        already_entitled: true,
        has_active_entitlement: true,
        return_url: `${siteUrl}/success?status=active`,
        user_id: currentUser.id,
      });
    }

    if (
      checkoutRequiresClaimToken({
        hasActiveEntitlement,
        claimToken: parsedBody.data.claim_token,
      })
    ) {
      return NextResponse.json(
        { error: "Start checkout from the Uttr desktop app." },
        { status: 400 },
      );
    }

    const claimToken = parsedBody.data.claim_token;
    if (!claimToken) {
      throw new CheckoutRouteError(400, "Missing claim token.");
    }

    const claimContext = await resolveClaimContext(claimToken, currentUser.id);
    const checkoutSession = await createOrReuseCheckoutSession({
      stripe,
      context: {
        userId: currentUser.id,
        anonymousTrialId: claimContext.anonymousTrialId,
        installId: claimContext.installId,
        monthlyPriceId,
        source,
        siteUrl,
        userEmail: currentUser.email,
        stripeCustomerId: entitlement?.stripe_customer_id ?? null,
      },
    });

    return NextResponse.json({
      url: checkoutSession.url,
      user_id: currentUser.id,
      has_active_entitlement: hasActiveEntitlement,
    });
  } catch (error) {
    if (error instanceof CheckoutRouteError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }

    console.error(
      JSON.stringify({
        level: "error",
        event: "checkout_session_failed",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );

    return NextResponse.json(
      { error: "Could not create checkout session." },
      { status: 500 },
    );
  }
}

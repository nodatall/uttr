import { NextResponse } from "next/server";
import { z } from "zod";
import {
  fetchAnonymousTrialById,
  fetchEntitlementByUserId,
  fetchSupabaseUser,
  fetchTrialClaimByHash,
  hashClaimToken,
  readSupabaseAccessTokenFromRequest,
  type ClaimTokenPayload,
  verifyClaimToken,
} from "@/lib/access";
import { readCheckoutConfig } from "@/lib/env";
import { buildCheckoutMetadata, getStripe } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  claim_token: z.string().min(1).max(4096).optional(),
  source: z.string().max(120).optional(),
});

function normalizeSource(source: string | undefined) {
  return source?.trim() || "direct";
}

async function resolveClaimContext(
  claimToken: string,
  userId: string,
) {
  let tokenPayload: ClaimTokenPayload;
  try {
    tokenPayload = verifyClaimToken(claimToken);
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : "Invalid claim token.",
    );
  }

  const claimTokenHash = hashClaimToken(claimToken);
  const claim = await fetchTrialClaimByHash(claimTokenHash);
  if (!claim) {
    throw new Error("Claim token not found.");
  }

  if (
    claim.id !== tokenPayload.claim_id ||
    claim.anonymous_trial_id !== tokenPayload.anonymous_trial_id ||
    claimTokenHash !== claim.claim_token_hash
  ) {
    throw new Error("Claim token payload mismatch.");
  }

  if (new Date(claim.expires_at).getTime() <= Date.now()) {
    throw new Error("Claim token expired.");
  }

  if (!claim.redeemed_at) {
    throw new Error("Claim token must be redeemed before checkout.");
  }

  const trial = await fetchAnonymousTrialById(claim.anonymous_trial_id);
  if (!trial || trial.install_id !== tokenPayload.install_id) {
    throw new Error("Claim token is no longer valid.");
  }

  if (trial.user_id !== userId) {
    throw new Error("Claim token is linked to a different user.");
  }

  return {
    anonymousTrialId: trial.id,
    installId: trial.install_id,
  };
}

export async function POST(request: Request) {
  try {
    const parsedBody = requestSchema.safeParse(await request.json());
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: "Invalid checkout payload." },
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
    if (!currentUser.email) {
      return NextResponse.json(
        { error: "Authenticated user is missing an email address." },
        { status: 400 },
      );
    }

    const { stripeSecretKey, monthlyPriceId, siteUrl } = readCheckoutConfig();
    const stripe = getStripe(stripeSecretKey);
    const source = normalizeSource(parsedBody.data.source);

    const claimContext = parsedBody.data.claim_token
      ? await resolveClaimContext(parsedBody.data.claim_token, currentUser.id)
      : null;

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: monthlyPriceId, quantity: 1 }],
      success_url: `${siteUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/cancel`,
      customer_email: currentUser.email,
      client_reference_id: currentUser.id,
      metadata: buildCheckoutMetadata({
        source,
        userId: currentUser.id,
        anonymousTrialId: claimContext?.anonymousTrialId,
        installId: claimContext?.installId,
      }),
      billing_address_collection: "auto",
      allow_promotion_codes: true,
    });

    if (!checkoutSession.url) {
      return NextResponse.json(
        { error: "Stripe did not return a checkout URL." },
        { status: 500 },
      );
    }

    const entitlement = await fetchEntitlementByUserId(currentUser.id);

    return NextResponse.json({
      url: checkoutSession.url,
      user_id: currentUser.id,
      has_active_entitlement: entitlement?.subscription_status === "active",
    });
  } catch (error) {
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

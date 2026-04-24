import { NextResponse } from "next/server";
import {
  fetchEntitlementByUserId,
  fetchAuthenticatedUser,
  readAccessTokenFromRequest,
} from "@/lib/access";
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

function respondToRateLimit(rateLimit: RateLimitBlockedDecision) {
  const failure = resolveRateLimitFailure(
    rateLimit,
    "Too many billing portal requests.",
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

export async function POST(request: Request) {
  try {
    const rateLimit = await checkRateLimit({
      key: rateLimitKeyFromRequest(request, "billing-portal"),
      limit: 20,
      windowMs: 60_000,
    });
    if (!rateLimit.allowed) {
      return respondToRateLimit(rateLimit);
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

    const entitlement = await fetchEntitlementByUserId(currentUser.id);
    const customerId = entitlement?.stripe_customer_id;
    if (!customerId) {
      return NextResponse.json(
        { error: "No billing portal is available for this account." },
        { status: 409 },
      );
    }

    const { stripeSecretKey, siteUrl } = readCheckoutConfig();
    const stripe = getStripe(stripeSecretKey);

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${siteUrl}/account?status=returned`,
    });

    return NextResponse.json({ url: portalSession.url });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "billing_portal_failed",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );

    return NextResponse.json(
      { error: "Could not open billing portal." },
      { status: 500 },
    );
  }
}

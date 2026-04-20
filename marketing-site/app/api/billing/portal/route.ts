import { NextResponse } from "next/server";
import {
  fetchEntitlementByUserId,
  fetchAuthenticatedUser,
  readAccessTokenFromRequest,
} from "@/lib/access";
import { readCheckoutConfig } from "@/lib/env";
import { getStripe } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const accessToken = readAccessTokenFromRequest(request);
    if (!accessToken) {
      return NextResponse.json(
        { error: "Missing session." },
        { status: 401 },
      );
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

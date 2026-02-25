import { NextResponse } from "next/server";
import { z } from "zod";
import { readCheckoutConfig } from "@/lib/env";
import { getStripe } from "@/lib/stripe";

const requestSchema = z.object({
  email: z.email().optional(),
  source: z.string().max(120).optional(),
});

export async function POST(request: Request) {
  try {
    const parsedBody = requestSchema.safeParse(await request.json());
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: "Invalid checkout payload." },
        { status: 400 },
      );
    }

    const { stripeSecretKey, monthlyPriceId, siteUrl } = readCheckoutConfig();
    const stripe = getStripe(stripeSecretKey);

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: monthlyPriceId, quantity: 1 }],
      success_url: `${siteUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/cancel`,
      customer_email: parsedBody.data.email,
      metadata: {
        source: parsedBody.data.source || "direct",
      },
      billing_address_collection: "auto",
      allow_promotion_codes: true,
    });

    if (!checkoutSession.url) {
      return NextResponse.json(
        { error: "Stripe did not return a checkout URL." },
        { status: 500 },
      );
    }

    return NextResponse.json({ url: checkoutSession.url });
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

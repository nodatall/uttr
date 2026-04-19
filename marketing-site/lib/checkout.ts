import Stripe from "stripe";
import {
  buildPendingCheckoutSessionContextKey,
  fetchReusableOpenCheckoutSession,
  insertPendingCheckoutSession,
} from "./access";
import { buildCheckoutMetadata } from "./stripe";

export type CheckoutClaimContext = {
  anonymousTrialId: string;
  installId: string;
};

type CheckoutSessionContext = CheckoutClaimContext & {
  userId: string;
  monthlyPriceId: string;
};

type CheckoutSessionCreateContext = CheckoutSessionContext & {
  source: string;
  siteUrl: string;
  userEmail: string;
  stripeCustomerId: string | null;
};

type CheckoutSessionDependencies = {
  fetchReusableOpenCheckoutSession?: typeof fetchReusableOpenCheckoutSession;
  insertPendingCheckoutSession?: typeof insertPendingCheckoutSession;
};

export function buildCheckoutSessionIdempotencyKey(
  params: CheckoutSessionContext,
) {
  return [
    "uttr_checkout",
    buildPendingCheckoutSessionContextKey(params),
    `price:${params.monthlyPriceId}`,
  ].join("|");
}

export function buildCheckoutSessionCreateParams(
  params: CheckoutSessionCreateContext,
): Stripe.Checkout.SessionCreateParams {
  const metadata = buildCheckoutMetadata({
    source: params.source,
    userId: params.userId,
    anonymousTrialId: params.anonymousTrialId,
    installId: params.installId,
  });

  return {
    mode: "subscription",
    line_items: [{ price: params.monthlyPriceId, quantity: 1 }],
    success_url: `${params.siteUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${params.siteUrl}/cancel`,
    client_reference_id: params.userId,
    metadata,
    subscription_data: {
      metadata,
    },
    billing_address_collection: "auto",
    allow_promotion_codes: true,
    ...(params.stripeCustomerId
      ? { customer: params.stripeCustomerId }
      : { customer_email: params.userEmail }),
  };
}

export async function createOrReuseCheckoutSession(params: {
  stripe: Stripe;
  context: CheckoutSessionCreateContext;
  dependencies?: CheckoutSessionDependencies;
}) {
  const fetchReusableSession =
    params.dependencies?.fetchReusableOpenCheckoutSession ??
    fetchReusableOpenCheckoutSession;
  const insertPendingSession =
    params.dependencies?.insertPendingCheckoutSession ??
    insertPendingCheckoutSession;
  const pendingContext = {
    userId: params.context.userId,
    anonymousTrialId: params.context.anonymousTrialId,
    installId: params.context.installId,
  };

  const reusableSession = await fetchReusableSession(pendingContext);
  if (reusableSession) {
    return {
      url: reusableSession.checkout_url,
      checkoutSession: reusableSession,
      reused: true,
    };
  }

  const checkoutSession = await params.stripe.checkout.sessions.create(
    buildCheckoutSessionCreateParams(params.context),
    {
      idempotencyKey: buildCheckoutSessionIdempotencyKey({
        ...pendingContext,
        monthlyPriceId: params.context.monthlyPriceId,
      }),
    },
  );

  if (!checkoutSession.url) {
    throw new Error("Stripe did not return a checkout URL.");
  }

  const stripeCustomerId =
    typeof checkoutSession.customer === "string"
      ? checkoutSession.customer
      : params.context.stripeCustomerId;

  try {
    const persistedSession = await insertPendingSession({
      userId: params.context.userId,
      anonymousTrialId: params.context.anonymousTrialId,
      installId: params.context.installId,
      stripeCheckoutSessionId: checkoutSession.id,
      stripeCustomerId,
      checkoutUrl: checkoutSession.url,
      expiresAt: new Date(checkoutSession.expires_at * 1000).toISOString(),
    });

    if (!persistedSession) {
      throw new Error("Pending checkout persistence returned no row.");
    }

    return {
      url: persistedSession.checkout_url,
      checkoutSession: persistedSession,
      reused: false,
    };
  } catch (error) {
    const reusableAfterInsertFailure = await fetchReusableSession(pendingContext).catch(
      () => null,
    );
    if (reusableAfterInsertFailure) {
      return {
        url: reusableAfterInsertFailure.checkout_url,
        checkoutSession: reusableAfterInsertFailure,
        reused: true,
      };
    }

    await params.stripe.checkout.sessions.expire(checkoutSession.id).catch(() => {
      // Best effort: the caller still fails rather than returning an untracked session.
    });

    throw error instanceof Error
      ? error
      : new Error("Could not persist checkout session.");
  }
}

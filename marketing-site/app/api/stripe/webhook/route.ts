import { NextResponse } from "next/server";
import Stripe from "stripe";
import { sendTransactionalEmail } from "@/lib/email";
import {
  fetchEntitlementByUserId,
  withStripeCustomerEntitlementLock,
  markPendingCheckoutSessionCompleted,
  markPendingCheckoutSessionExpired,
  patchEntitlementByStripeSubscriptionId,
  upsertEntitlementState,
  type EntitlementState,
} from "@/lib/access";
import { readEmailConfig, readWebhookConfig } from "@/lib/env";
import {
  beginWebhookEvent,
  completeWebhookEvent,
  failWebhookEvent,
} from "@/lib/idempotency";
import { getStripe } from "@/lib/stripe";

export const runtime = "nodejs";

async function resolveCustomerEmail(
  stripe: Stripe,
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null,
): Promise<string | null> {
  if (!customer) {
    return null;
  }

  if (typeof customer === "object") {
    if ("deleted" in customer && customer.deleted) {
      return null;
    }
    return customer.email;
  }

  const customerRecord = await stripe.customers.retrieve(customer);
  if ("deleted" in customerRecord && customerRecord.deleted) {
    return null;
  }

  return customerRecord.email;
}

async function sendSupportFallbackIfMissingEmail(subject: string) {
  const { supportEmail } = readEmailConfig();
  console.info(
    JSON.stringify({
      level: "info",
      event: "email_missing_customer",
      subject,
      supportEmail,
    }),
  );
}

function stripeId(value: string | { id?: string } | null): string | null {
  if (!value) {
    return null;
  }

  return typeof value === "string" ? value : (value.id ?? null);
}

function mapSubscriptionStatus(
  status: Stripe.Subscription.Status,
): EntitlementState {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
      return "past_due";
    case "canceled":
      return "canceled";
    case "incomplete_expired":
      return "expired";
    default:
      return "inactive";
  }
}

function currentPeriodEndsAt(subscription: Stripe.Subscription): string | null {
  const currentPeriodEnd =
    subscription.items?.data[0]?.current_period_end ??
    (subscription as { current_period_end?: unknown }).current_period_end;

  if (typeof currentPeriodEnd !== "number") {
    return null;
  }

  return new Date(currentPeriodEnd * 1000).toISOString();
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  return stripeId(
    invoice.parent?.subscription_details?.subscription ??
      (invoice as { subscription?: string | { id?: string } | null })
        .subscription ??
      null,
  );
}

async function syncEntitlementFromSubscription(
  subscriptionId: string,
  customerId: string | null,
  stripe: Stripe,
  checkoutUserId?: string,
): Promise<Stripe.Subscription | null> {
  if (!customerId) {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    customerId = stripeId(subscription.customer);
  }
  if (!customerId) {
    throw new Error("Subscription is missing customer data.");
  }
  const lockedCustomerId = customerId;

  // Serialize the provider read with its write, not just the database update.
  return withStripeCustomerEntitlementLock(
    lockedCustomerId,
    async (executor) => {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      if (stripeId(subscription.customer) !== lockedCustomerId) {
        throw new Error(
          "Subscription customer does not match webhook customer.",
        );
      }
      const patch = {
        subscription_status: mapSubscriptionStatus(subscription.status),
        stripe_customer_id: lockedCustomerId,
        current_period_ends_at: currentPeriodEndsAt(subscription),
      };
      const userId = checkoutUserId || subscription.metadata?.user_id;
      if (userId) {
        const entitlement = await fetchEntitlementByUserId(userId, executor);
        const currentSubscriptionId =
          entitlement?.stripe_subscription_id ?? null;
        if (
          currentSubscriptionId &&
          currentSubscriptionId !== subscription.id
        ) {
          // Updates and invoices may reconcile only the currently associated subscription.
          if (!checkoutUserId) {
            return null;
          }
          const currentSubscription = await stripe.subscriptions.retrieve(
            currentSubscriptionId,
          );
          if (
            !Number.isFinite(subscription.created) ||
            !Number.isFinite(currentSubscription.created)
          ) {
            throw new Error("Cannot determine subscription checkout order.");
          }
          if (subscription.created <= currentSubscription.created) {
            return null;
          }
        }
        const saved = await upsertEntitlementState(
          {
            user_id: userId,
            stripe_subscription_id: subscription.id,
            ...patch,
          },
          executor,
          currentSubscriptionId,
        );
        if (!saved) {
          // A checkout on another customer can race this customer-scoped lock.
          throw new Error(
            "Subscription association changed during reconciliation.",
          );
        }
        return subscription;
      }

      const entitlement = await patchEntitlementByStripeSubscriptionId(
        subscription.id,
        patch,
        executor,
      );
      if (!entitlement) {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "subscription_entitlement_missing_user",
            subscriptionId: subscription.id,
          }),
        );
        return null;
      }
      return subscription;
    },
  );
}

async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
  stripe: Stripe,
) {
  const userId = session.client_reference_id || session.metadata?.user_id;
  if (!userId) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "checkout_entitlement_missing_user",
        sessionId: session.id,
      }),
    );
    throw new Error("Completed checkout session is missing user metadata.");
  }
  const subscriptionId = stripeId(session.subscription);
  const customerId = stripeId(session.customer);
  if (!subscriptionId) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "checkout_entitlement_missing_stripe_ids",
        sessionId: session.id,
        hasCustomer: Boolean(customerId),
        hasSubscription: Boolean(subscriptionId),
      }),
    );
    throw new Error(
      "Completed checkout session is missing subscription or customer data.",
    );
  }
  return syncEntitlementFromSubscription(
    subscriptionId,
    customerId,
    stripe,
    userId,
  );
}

async function syncEntitlementFromInvoice(
  invoice: Stripe.Invoice,
  stripe: Stripe,
) {
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (subscriptionId) {
    await syncEntitlementFromSubscription(
      subscriptionId,
      stripeId(invoice.customer),
      stripe,
    );
  }
}

async function sendCheckoutCompletedEmail(
  session: Stripe.Checkout.Session,
  stripe: Stripe,
) {
  const email =
    session.customer_details?.email ||
    (await resolveCustomerEmail(stripe, session.customer));

  if (!email) {
    await sendSupportFallbackIfMissingEmail(
      "welcome_email_missing_customer_email",
    );
    return;
  }

  const { supportEmail } = readEmailConfig();
  await sendTransactionalEmail({
    to: email,
    subject: "Welcome to Uttr Pro",
    html: `<p>Thanks for subscribing to Uttr Pro.</p><p>Your subscription is active at <strong>$5/month</strong>.</p><p>If you need anything, reply here or email <a href=\"mailto:${supportEmail}\">${supportEmail}</a>.</p>`,
  });
}

type PostCommitSideEffect = () => Promise<void>;

async function handleInvoicePaid(invoice: Stripe.Invoice, stripe: Stripe) {
  const email =
    invoice.customer_email ||
    (await resolveCustomerEmail(stripe, invoice.customer));

  if (!email) {
    await sendSupportFallbackIfMissingEmail(
      "invoice_paid_missing_customer_email",
    );
    return;
  }

  await sendTransactionalEmail({
    to: email,
    subject: "Uttr payment confirmed",
    html: "<p>Your Uttr Pro subscription payment succeeded. You are all set for another month.</p>",
  });
}

async function handleInvoiceFailed(invoice: Stripe.Invoice, stripe: Stripe) {
  const email =
    invoice.customer_email ||
    (await resolveCustomerEmail(stripe, invoice.customer));

  if (!email) {
    await sendSupportFallbackIfMissingEmail(
      "invoice_failed_missing_customer_email",
    );
    return;
  }

  await sendTransactionalEmail({
    to: email,
    subject: "Action needed: update your Uttr payment method",
    html: "<p>We could not process your latest Uttr Pro payment. Please update your payment method to keep your subscription active.</p>",
  });
}

async function sendSubscriptionDeletedEmail(
  subscription: Stripe.Subscription,
  stripe: Stripe,
) {
  const email = await resolveCustomerEmail(stripe, subscription.customer);

  if (!email) {
    await sendSupportFallbackIfMissingEmail(
      "subscription_deleted_missing_customer_email",
    );
    return;
  }

  await sendTransactionalEmail({
    to: email,
    subject: "Your Uttr subscription has been canceled",
    html: "<p>Your Uttr Pro subscription is now canceled. You can resubscribe at any time from uttr.pro.</p>",
  });
}

async function sendSubscriptionUpdatedEmail(
  event: Stripe.Event,
  subscription: Stripe.Subscription,
  stripe: Stripe,
) {
  const priorStatus =
    (event.data.previous_attributes as { status?: Stripe.Subscription.Status })
      ?.status || null;

  if (!priorStatus || priorStatus === subscription.status) {
    return;
  }

  if (!["past_due", "unpaid", "canceled"].includes(subscription.status)) {
    return;
  }

  const email = await resolveCustomerEmail(stripe, subscription.customer);
  if (!email) {
    await sendSupportFallbackIfMissingEmail(
      "subscription_updated_missing_customer_email",
    );
    return;
  }

  await sendTransactionalEmail({
    to: email,
    subject: "Your Uttr subscription status changed",
    html: `<p>Your subscription status is now <strong>${subscription.status}</strong>. If this was unexpected, contact support.</p>`,
  });
}

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json(
      { error: "Missing stripe-signature header." },
      { status: 400 },
    );
  }

  let processingEventId: string | null = null;

  try {
    const { stripeSecretKey, webhookSecret } = readWebhookConfig();
    const stripe = getStripe(stripeSecretKey);
    const payload = await request.text();

    const event = stripe.webhooks.constructEvent(
      payload,
      signature,
      webhookSecret,
    );

    const beginStatus = await beginWebhookEvent(event.id, event.type);
    if (beginStatus === "duplicate") {
      return NextResponse.json({ received: true, duplicate: true });
    }
    if (beginStatus === "in_progress") {
      return NextResponse.json(
        { error: "Webhook event is already processing." },
        { status: 409 },
      );
    }

    processingEventId = event.id;
    let postCommitSideEffect: PostCommitSideEffect | null = null;

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        await markPendingCheckoutSessionCompleted(session.id);
        const subscription = await handleCheckoutCompleted(session, stripe);
        if (subscription) {
          postCommitSideEffect = () =>
            sendCheckoutCompletedEmail(session, stripe);
        }
        break;
      }
      case "checkout.session.expired": {
        const session = event.data.object as Stripe.Checkout.Session;
        await markPendingCheckoutSessionExpired(session.id);
        break;
      }
      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        await syncEntitlementFromInvoice(invoice, stripe);
        postCommitSideEffect = () => handleInvoicePaid(invoice, stripe);
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        await syncEntitlementFromInvoice(invoice, stripe);
        postCommitSideEffect = () => handleInvoiceFailed(invoice, stripe);
        break;
      }
      case "customer.subscription.deleted": {
        const snapshot = event.data.object as Stripe.Subscription;
        const subscription = await syncEntitlementFromSubscription(
          snapshot.id,
          stripeId(snapshot.customer),
          stripe,
        );
        if (subscription?.status === "canceled") {
          postCommitSideEffect = () =>
            sendSubscriptionDeletedEmail(subscription, stripe);
        }
        break;
      }
      case "customer.subscription.updated": {
        const snapshot = event.data.object as Stripe.Subscription;
        const subscription = await syncEntitlementFromSubscription(
          snapshot.id,
          stripeId(snapshot.customer),
          stripe,
        );
        if (subscription) {
          postCommitSideEffect = () =>
            sendSubscriptionUpdatedEmail(event, subscription, stripe);
        }
        break;
      }
      default:
        break;
    }

    await completeWebhookEvent(event.id);
    processingEventId = null;

    if (postCommitSideEffect) {
      await postCommitSideEffect().catch((error) => {
        console.error(
          JSON.stringify({
            level: "error",
            event: "stripe_webhook_post_commit_side_effect_failed",
            stripeEventId: event.id,
            stripeType: event.type,
            message: error instanceof Error ? error.message : "Unknown error",
          }),
        );
      });
    }

    console.info(
      JSON.stringify({
        level: "info",
        event: "stripe_webhook_processed",
        stripeEventId: event.id,
        stripeType: event.type,
      }),
    );

    return NextResponse.json({ received: true });
  } catch (error) {
    if (processingEventId) {
      await failWebhookEvent(processingEventId, error).catch((failError) => {
        console.error(
          JSON.stringify({
            level: "error",
            event: "stripe_webhook_mark_failed_failed",
            stripeEventId: processingEventId,
            message:
              failError instanceof Error ? failError.message : "Unknown error",
          }),
        );
      });
    }

    console.error(
      JSON.stringify({
        level: "error",
        event: "stripe_webhook_failed",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );

    return NextResponse.json(
      { error: "Webhook processing failed." },
      { status: 400 },
    );
  }
}

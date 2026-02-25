import { NextResponse } from "next/server";
import Stripe from "stripe";
import { sendTransactionalEmail } from "@/lib/email";
import { readEmailConfig, readWebhookConfig } from "@/lib/env";
import { registerWebhookEvent } from "@/lib/idempotency";
import { getStripe } from "@/lib/stripe";

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

async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
  stripe: Stripe,
) {
  const email = session.customer_details?.email ||
    (await resolveCustomerEmail(stripe, session.customer));

  if (!email) {
    await sendSupportFallbackIfMissingEmail("welcome_email_missing_customer_email");
    return;
  }

  const { supportEmail } = readEmailConfig();
  await sendTransactionalEmail({
    to: email,
    subject: "Welcome to Uttr Pro",
    html: `<p>Thanks for subscribing to Uttr Pro.</p><p>Your subscription is active at <strong>$5/month</strong>.</p><p>If you need anything, reply here or email <a href=\"mailto:${supportEmail}\">${supportEmail}</a>.</p>`,
  });
}

async function handleInvoicePaid(invoice: Stripe.Invoice, stripe: Stripe) {
  const email =
    invoice.customer_email || (await resolveCustomerEmail(stripe, invoice.customer));

  if (!email) {
    await sendSupportFallbackIfMissingEmail("invoice_paid_missing_customer_email");
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
    invoice.customer_email || (await resolveCustomerEmail(stripe, invoice.customer));

  if (!email) {
    await sendSupportFallbackIfMissingEmail("invoice_failed_missing_customer_email");
    return;
  }

  await sendTransactionalEmail({
    to: email,
    subject: "Action needed: update your Uttr payment method",
    html: "<p>We could not process your latest Uttr Pro payment. Please update your payment method to keep your subscription active.</p>",
  });
}

async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription,
  stripe: Stripe,
) {
  const email = await resolveCustomerEmail(stripe, subscription.customer);

  if (!email) {
    await sendSupportFallbackIfMissingEmail("subscription_deleted_missing_customer_email");
    return;
  }

  await sendTransactionalEmail({
    to: email,
    subject: "Your Uttr subscription has been canceled",
    html: "<p>Your Uttr Pro subscription is now canceled. You can resubscribe at any time from uttr.app.</p>",
  });
}

async function handleSubscriptionUpdated(
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
    await sendSupportFallbackIfMissingEmail("subscription_updated_missing_customer_email");
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

  try {
    const { stripeSecretKey, webhookSecret } = readWebhookConfig();
    const stripe = getStripe(stripeSecretKey);
    const payload = await request.text();

    const event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);

    if (!registerWebhookEvent(event.id)) {
      return NextResponse.json({ received: true, duplicate: true });
    }

    switch (event.type) {
      case "checkout.session.completed": {
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session, stripe);
        break;
      }
      case "invoice.paid": {
        await handleInvoicePaid(event.data.object as Stripe.Invoice, stripe);
        break;
      }
      case "invoice.payment_failed": {
        await handleInvoiceFailed(event.data.object as Stripe.Invoice, stripe);
        break;
      }
      case "customer.subscription.deleted": {
        await handleSubscriptionDeleted(
          event.data.object as Stripe.Subscription,
          stripe,
        );
        break;
      }
      case "customer.subscription.updated": {
        await handleSubscriptionUpdated(
          event,
          event.data.object as Stripe.Subscription,
          stripe,
        );
        break;
      }
      default:
        break;
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

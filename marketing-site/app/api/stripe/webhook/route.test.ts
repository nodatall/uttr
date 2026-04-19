import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type Stripe from "stripe";

type StripeWebhookEvent = Stripe.Event & {
  data: {
    object: Stripe.Checkout.Session | Stripe.Invoice | Stripe.Subscription;
  };
};

const markPendingCheckoutSessionCompletedCalls: string[] = [];
const markPendingCheckoutSessionExpiredCalls: string[] = [];
const upsertEntitlementStateCalls: Array<Record<string, unknown>> = [];
const patchEntitlementByStripeSubscriptionIdCalls: Array<Record<string, unknown>> = [];
const sendTransactionalEmailCalls: Array<Record<string, unknown>> = [];
const registerWebhookEventCalls: Array<[string, string]> = [];

let registerWebhookEventResult = true;
let stripeWebhookEvent: StripeWebhookEvent = buildCompletedEvent();
let stripeMock = buildStripeMock();

mock.module("@/lib/access", () => ({
  markPendingCheckoutSessionCompleted: async (stripeCheckoutSessionId: string) => {
    markPendingCheckoutSessionCompletedCalls.push(stripeCheckoutSessionId);
    return null;
  },
  markPendingCheckoutSessionExpired: async (stripeCheckoutSessionId: string) => {
    markPendingCheckoutSessionExpiredCalls.push(stripeCheckoutSessionId);
    return null;
  },
  patchEntitlementByStripeSubscriptionId: async (
    stripeSubscriptionId: string,
    patch: Record<string, unknown>,
  ) => {
    patchEntitlementByStripeSubscriptionIdCalls.push({
      stripeSubscriptionId,
      patch,
    });
    return null;
  },
  upsertEntitlementState: async (row: Record<string, unknown>) => {
    upsertEntitlementStateCalls.push(row);
    return row;
  },
}));

mock.module("@/lib/email", () => ({
  sendTransactionalEmail: async (params: Record<string, unknown>) => {
    sendTransactionalEmailCalls.push(params);
  },
}));

mock.module("@/lib/env", () => ({
  readEmailConfig: () => ({ supportEmail: "support@uttr.test" }),
  readWebhookConfig: () => ({
    stripeSecretKey: "sk_test_webhook",
    webhookSecret: "whsec_test",
  }),
}));

mock.module("@/lib/idempotency", () => ({
  registerWebhookEvent: async (eventId: string, eventType: string) => {
    registerWebhookEventCalls.push([eventId, eventType]);
    return registerWebhookEventResult;
  },
}));

mock.module("@/lib/stripe", () => ({
  getStripe: () => stripeMock,
}));

const { POST } = await import("./route");

beforeEach(() => {
  markPendingCheckoutSessionCompletedCalls.length = 0;
  markPendingCheckoutSessionExpiredCalls.length = 0;
  upsertEntitlementStateCalls.length = 0;
  patchEntitlementByStripeSubscriptionIdCalls.length = 0;
  sendTransactionalEmailCalls.length = 0;
  registerWebhookEventCalls.length = 0;
  registerWebhookEventResult = true;
  stripeWebhookEvent = buildCompletedEvent();
  stripeMock = buildStripeMock();
});

afterEach(() => {
  markPendingCheckoutSessionCompletedCalls.length = 0;
  markPendingCheckoutSessionExpiredCalls.length = 0;
  upsertEntitlementStateCalls.length = 0;
  patchEntitlementByStripeSubscriptionIdCalls.length = 0;
  sendTransactionalEmailCalls.length = 0;
  registerWebhookEventCalls.length = 0;
});

function buildCompletedEvent(): StripeWebhookEvent {
  return {
    id: "evt_completed_123",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_completed_123",
        client_reference_id: "user_123",
        customer: "cus_test_123",
        customer_details: {
          email: "user@example.com",
        },
        metadata: {
          user_id: "user_123",
        },
        subscription: "sub_test_123",
      } as Stripe.Checkout.Session,
    },
  } as StripeWebhookEvent;
}

function buildExpiredEvent(): StripeWebhookEvent {
  return {
    id: "evt_expired_123",
    type: "checkout.session.expired",
    data: {
      object: {
        id: "cs_test_expired_123",
        client_reference_id: "user_123",
        customer: "cus_test_123",
        metadata: {
          user_id: "user_123",
        },
        subscription: null,
      } as Stripe.Checkout.Session,
    },
  } as StripeWebhookEvent;
}

function buildUnknownEvent(): StripeWebhookEvent {
  return {
    id: "evt_unknown_123",
    type: "customer.subscription.created",
    data: {
      object: {
        id: "sub_test_123",
        customer: "cus_test_123",
        metadata: {
          user_id: "user_123",
        },
        status: "active",
        current_period_end: 1_900_000_000,
      } as Stripe.Subscription,
    },
  } as StripeWebhookEvent;
}

function buildStripeMock() {
  return {
    webhooks: {
      constructEvent: () => stripeWebhookEvent,
    },
    subscriptions: {
      retrieve: async () => ({
        id: "sub_test_123",
        customer: "cus_test_123",
        metadata: {
          user_id: "user_123",
        },
        status: "active",
        current_period_end: 1_900_000_000,
      }),
    },
    customers: {
      retrieve: async () => ({
        id: "cus_test_123",
        email: "user@example.com",
      }),
    },
  } as never;
}

async function invokeWebhook() {
  return POST(
    new Request("https://uttr.test/api/stripe/webhook", {
      method: "POST",
      headers: {
        "stripe-signature": "sig_test",
      },
      body: "{}",
    }),
  );
}

describe("stripe webhook pending checkout lifecycle", () => {
  test("marks completed checkout sessions and still syncs entitlement", async () => {
    stripeWebhookEvent = buildCompletedEvent();

    const response = await invokeWebhook();
    const payload = (await response.json()) as { received: boolean };

    expect(response.status).toBe(200);
    expect(payload).toEqual({ received: true });
    expect(registerWebhookEventCalls).toEqual([
      ["evt_completed_123", "checkout.session.completed"],
    ]);
    expect(markPendingCheckoutSessionCompletedCalls).toEqual([
      "cs_test_completed_123",
    ]);
    expect(markPendingCheckoutSessionExpiredCalls).toEqual([]);
    expect(upsertEntitlementStateCalls).toEqual([
      {
        user_id: "user_123",
        subscription_status: "active",
        stripe_customer_id: "cus_test_123",
        stripe_subscription_id: "sub_test_123",
        current_period_ends_at: "2030-03-17T17:46:40.000Z",
      },
    ]);
    expect(sendTransactionalEmailCalls).toHaveLength(1);
    expect(patchEntitlementByStripeSubscriptionIdCalls).toHaveLength(0);
  });

  test("marks expired checkout sessions", async () => {
    stripeWebhookEvent = buildExpiredEvent();

    const response = await invokeWebhook();
    const payload = (await response.json()) as { received: boolean };

    expect(response.status).toBe(200);
    expect(payload).toEqual({ received: true });
    expect(registerWebhookEventCalls).toEqual([
      ["evt_expired_123", "checkout.session.expired"],
    ]);
    expect(markPendingCheckoutSessionCompletedCalls).toEqual([]);
    expect(markPendingCheckoutSessionExpiredCalls).toEqual([
      "cs_test_expired_123",
    ]);
    expect(upsertEntitlementStateCalls).toHaveLength(0);
    expect(sendTransactionalEmailCalls).toHaveLength(0);
  });

  test("keeps webhook idempotency intact for duplicate events", async () => {
    registerWebhookEventResult = false;
    stripeWebhookEvent = buildCompletedEvent();

    const response = await invokeWebhook();
    const payload = (await response.json()) as {
      received: boolean;
      duplicate: boolean;
    };

    expect(response.status).toBe(200);
    expect(payload).toEqual({ received: true, duplicate: true });
    expect(registerWebhookEventCalls).toEqual([
      ["evt_completed_123", "checkout.session.completed"],
    ]);
    expect(markPendingCheckoutSessionCompletedCalls).toHaveLength(0);
    expect(markPendingCheckoutSessionExpiredCalls).toHaveLength(0);
    expect(upsertEntitlementStateCalls).toHaveLength(0);
    expect(sendTransactionalEmailCalls).toHaveLength(0);
  });

  test("returns success for unhandled events after idempotency registration", async () => {
    stripeWebhookEvent = buildUnknownEvent();

    const response = await invokeWebhook();
    const payload = (await response.json()) as { received: boolean };

    expect(response.status).toBe(200);
    expect(payload).toEqual({ received: true });
    expect(registerWebhookEventCalls).toEqual([
      ["evt_unknown_123", "customer.subscription.created"],
    ]);
    expect(markPendingCheckoutSessionCompletedCalls).toHaveLength(0);
    expect(markPendingCheckoutSessionExpiredCalls).toHaveLength(0);
    expect(upsertEntitlementStateCalls).toHaveLength(0);
    expect(sendTransactionalEmailCalls).toHaveLength(0);
  });
});

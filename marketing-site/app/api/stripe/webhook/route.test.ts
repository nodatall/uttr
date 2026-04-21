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
const patchEntitlementByStripeSubscriptionIdCalls: Array<
  Record<string, unknown>
> = [];
const sendTransactionalEmailCalls: Array<Record<string, unknown>> = [];
const beginWebhookEventCalls: Array<[string, string]> = [];
const completeWebhookEventCalls: string[] = [];
const failWebhookEventCalls: Array<[string, string]> = [];
const callOrder: string[] = [];

let beginWebhookEventResult: "process" | "duplicate" | "in_progress" =
  "process";
let upsertEntitlementStateShouldFail = false;
let completeWebhookEventShouldFail = false;
let sendTransactionalEmailShouldFail = false;
let stripeWebhookEvent: StripeWebhookEvent = buildCompletedEvent();
let stripeMock = buildStripeMock();

mock.module("@/lib/access", () => ({
  markPendingCheckoutSessionCompleted: async (
    stripeCheckoutSessionId: string,
  ) => {
    callOrder.push("mark_pending_completed");
    markPendingCheckoutSessionCompletedCalls.push(stripeCheckoutSessionId);
    return null;
  },
  markPendingCheckoutSessionExpired: async (
    stripeCheckoutSessionId: string,
  ) => {
    callOrder.push("mark_pending_expired");
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
    callOrder.push("upsert_entitlement");
    if (upsertEntitlementStateShouldFail) {
      throw new Error("entitlement write failed");
    }
    upsertEntitlementStateCalls.push(row);
    return row;
  },
}));

mock.module("@/lib/email", () => ({
  sendTransactionalEmail: async (params: Record<string, unknown>) => {
    callOrder.push("send_email");
    if (sendTransactionalEmailShouldFail) {
      throw new Error("email send failed");
    }
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
  beginWebhookEvent: async (eventId: string, eventType: string) => {
    callOrder.push("begin_event");
    beginWebhookEventCalls.push([eventId, eventType]);
    return beginWebhookEventResult;
  },
  completeWebhookEvent: async (eventId: string) => {
    callOrder.push("complete_event");
    if (completeWebhookEventShouldFail) {
      throw new Error("completion write failed");
    }
    completeWebhookEventCalls.push(eventId);
  },
  failWebhookEvent: async (eventId: string, error: unknown) => {
    callOrder.push("fail_event");
    failWebhookEventCalls.push([
      eventId,
      error instanceof Error ? error.message : "Unknown error",
    ]);
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
  beginWebhookEventCalls.length = 0;
  completeWebhookEventCalls.length = 0;
  failWebhookEventCalls.length = 0;
  callOrder.length = 0;
  beginWebhookEventResult = "process";
  upsertEntitlementStateShouldFail = false;
  completeWebhookEventShouldFail = false;
  sendTransactionalEmailShouldFail = false;
  stripeWebhookEvent = buildCompletedEvent();
  stripeMock = buildStripeMock();
});

afterEach(() => {
  markPendingCheckoutSessionCompletedCalls.length = 0;
  markPendingCheckoutSessionExpiredCalls.length = 0;
  upsertEntitlementStateCalls.length = 0;
  patchEntitlementByStripeSubscriptionIdCalls.length = 0;
  sendTransactionalEmailCalls.length = 0;
  beginWebhookEventCalls.length = 0;
  completeWebhookEventCalls.length = 0;
  failWebhookEventCalls.length = 0;
  callOrder.length = 0;
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

function buildMalformedCompletedEvent(): StripeWebhookEvent {
  return {
    id: "evt_completed_malformed_123",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_completed_malformed_123",
        client_reference_id: null,
        customer: "cus_test_123",
        customer_details: {
          email: "user@example.com",
        },
        metadata: {},
        subscription: "sub_test_123",
      } as Stripe.Checkout.Session,
    },
  } as StripeWebhookEvent;
}

function buildMissingStripeIdsCompletedEvent(): StripeWebhookEvent {
  return {
    id: "evt_completed_missing_ids_123",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_completed_missing_ids_123",
        client_reference_id: "user_123",
        customer: null,
        customer_details: {
          email: "user@example.com",
        },
        metadata: {
          user_id: "user_123",
        },
        subscription: null,
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
    expect(beginWebhookEventCalls).toEqual([
      ["evt_completed_123", "checkout.session.completed"],
    ]);
    expect(completeWebhookEventCalls).toEqual(["evt_completed_123"]);
    expect(failWebhookEventCalls).toHaveLength(0);
    expect(callOrder).toEqual([
      "begin_event",
      "mark_pending_completed",
      "upsert_entitlement",
      "complete_event",
      "send_email",
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
    expect(beginWebhookEventCalls).toEqual([
      ["evt_expired_123", "checkout.session.expired"],
    ]);
    expect(completeWebhookEventCalls).toEqual(["evt_expired_123"]);
    expect(failWebhookEventCalls).toHaveLength(0);
    expect(markPendingCheckoutSessionCompletedCalls).toEqual([]);
    expect(markPendingCheckoutSessionExpiredCalls).toEqual([
      "cs_test_expired_123",
    ]);
    expect(upsertEntitlementStateCalls).toHaveLength(0);
    expect(sendTransactionalEmailCalls).toHaveLength(0);
  });

  test("keeps webhook idempotency intact for duplicate events", async () => {
    beginWebhookEventResult = "duplicate";
    stripeWebhookEvent = buildCompletedEvent();

    const response = await invokeWebhook();
    const payload = (await response.json()) as {
      received: boolean;
      duplicate: boolean;
    };

    expect(response.status).toBe(200);
    expect(payload).toEqual({ received: true, duplicate: true });
    expect(beginWebhookEventCalls).toEqual([
      ["evt_completed_123", "checkout.session.completed"],
    ]);
    expect(completeWebhookEventCalls).toHaveLength(0);
    expect(failWebhookEventCalls).toHaveLength(0);
    expect(markPendingCheckoutSessionCompletedCalls).toHaveLength(0);
    expect(markPendingCheckoutSessionExpiredCalls).toHaveLength(0);
    expect(upsertEntitlementStateCalls).toHaveLength(0);
    expect(sendTransactionalEmailCalls).toHaveLength(0);
  });

  test("asks Stripe to retry concurrent deliveries that are still processing", async () => {
    beginWebhookEventResult = "in_progress";
    stripeWebhookEvent = buildCompletedEvent();

    const response = await invokeWebhook();
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(409);
    expect(payload).toEqual({ error: "Webhook event is already processing." });
    expect(beginWebhookEventCalls).toEqual([
      ["evt_completed_123", "checkout.session.completed"],
    ]);
    expect(completeWebhookEventCalls).toHaveLength(0);
    expect(failWebhookEventCalls).toHaveLength(0);
    expect(markPendingCheckoutSessionCompletedCalls).toHaveLength(0);
    expect(upsertEntitlementStateCalls).toHaveLength(0);
    expect(sendTransactionalEmailCalls).toHaveLength(0);
  });

  test("marks failed processing as retryable instead of permanently registering the event", async () => {
    stripeWebhookEvent = buildCompletedEvent();
    upsertEntitlementStateShouldFail = true;

    const response = await invokeWebhook();
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(payload).toEqual({ error: "Webhook processing failed." });
    expect(beginWebhookEventCalls).toEqual([
      ["evt_completed_123", "checkout.session.completed"],
    ]);
    expect(completeWebhookEventCalls).toHaveLength(0);
    expect(failWebhookEventCalls).toEqual([
      ["evt_completed_123", "entitlement write failed"],
    ]);
    expect(callOrder).toEqual([
      "begin_event",
      "mark_pending_completed",
      "upsert_entitlement",
      "fail_event",
    ]);
  });

  test("fails completed checkout events that cannot write an entitlement", async () => {
    stripeWebhookEvent = buildMalformedCompletedEvent();

    const response = await invokeWebhook();
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(payload).toEqual({ error: "Webhook processing failed." });
    expect(beginWebhookEventCalls).toEqual([
      ["evt_completed_malformed_123", "checkout.session.completed"],
    ]);
    expect(completeWebhookEventCalls).toHaveLength(0);
    expect(failWebhookEventCalls).toEqual([
      [
        "evt_completed_malformed_123",
        "Completed checkout session is missing user metadata.",
      ],
    ]);
    expect(callOrder).toEqual([
      "begin_event",
      "mark_pending_completed",
      "fail_event",
    ]);
    expect(markPendingCheckoutSessionCompletedCalls).toEqual([
      "cs_test_completed_malformed_123",
    ]);
    expect(upsertEntitlementStateCalls).toHaveLength(0);
    expect(sendTransactionalEmailCalls).toHaveLength(0);
  });

  test("fails completed checkout events missing subscription or customer ids", async () => {
    stripeWebhookEvent = buildMissingStripeIdsCompletedEvent();

    const response = await invokeWebhook();
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(payload).toEqual({ error: "Webhook processing failed." });
    expect(completeWebhookEventCalls).toHaveLength(0);
    expect(failWebhookEventCalls).toEqual([
      [
        "evt_completed_missing_ids_123",
        "Completed checkout session is missing subscription or customer data.",
      ],
    ]);
    expect(markPendingCheckoutSessionCompletedCalls).toEqual([
      "cs_test_completed_missing_ids_123",
    ]);
    expect(upsertEntitlementStateCalls).toHaveLength(0);
    expect(sendTransactionalEmailCalls).toHaveLength(0);
  });

  test("does not send post-commit email before completion bookkeeping succeeds", async () => {
    stripeWebhookEvent = buildCompletedEvent();
    completeWebhookEventShouldFail = true;

    const response = await invokeWebhook();
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(payload).toEqual({ error: "Webhook processing failed." });
    expect(beginWebhookEventCalls).toEqual([
      ["evt_completed_123", "checkout.session.completed"],
    ]);
    expect(completeWebhookEventCalls).toHaveLength(0);
    expect(failWebhookEventCalls).toEqual([
      ["evt_completed_123", "completion write failed"],
    ]);
    expect(sendTransactionalEmailCalls).toHaveLength(0);
    expect(callOrder).toEqual([
      "begin_event",
      "mark_pending_completed",
      "upsert_entitlement",
      "complete_event",
      "fail_event",
    ]);
  });

  test("logs post-commit email failures without reopening a processed event", async () => {
    stripeWebhookEvent = buildCompletedEvent();
    sendTransactionalEmailShouldFail = true;

    const response = await invokeWebhook();
    const payload = (await response.json()) as { received: boolean };

    expect(response.status).toBe(200);
    expect(payload).toEqual({ received: true });
    expect(completeWebhookEventCalls).toEqual(["evt_completed_123"]);
    expect(failWebhookEventCalls).toHaveLength(0);
    expect(callOrder).toEqual([
      "begin_event",
      "mark_pending_completed",
      "upsert_entitlement",
      "complete_event",
      "send_email",
    ]);
  });

  test("returns success for unhandled events after idempotency registration", async () => {
    stripeWebhookEvent = buildUnknownEvent();

    const response = await invokeWebhook();
    const payload = (await response.json()) as { received: boolean };

    expect(response.status).toBe(200);
    expect(payload).toEqual({ received: true });
    expect(beginWebhookEventCalls).toEqual([
      ["evt_unknown_123", "customer.subscription.created"],
    ]);
    expect(completeWebhookEventCalls).toEqual(["evt_unknown_123"]);
    expect(failWebhookEventCalls).toHaveLength(0);
    expect(markPendingCheckoutSessionCompletedCalls).toHaveLength(0);
    expect(markPendingCheckoutSessionExpiredCalls).toHaveLength(0);
    expect(upsertEntitlementStateCalls).toHaveLength(0);
    expect(sendTransactionalEmailCalls).toHaveLength(0);
  });
});

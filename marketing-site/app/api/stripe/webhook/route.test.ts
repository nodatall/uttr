import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Stripe } from "stripe";
import { setTimeout as delay } from "node:timers/promises";

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
const constructEventCalls: Array<[string, string, string]> = [];
const callOrder: string[] = [];
const retrieveSubscriptionCalls: string[] = [];
let existingEntitlement: Record<string, unknown> | null = null;
let associationChangesBeforeWrite = false;
let lockTail = Promise.resolve();
let retrievedSubscriptions: Record<string, Stripe.Subscription> = {};

let beginWebhookEventResult: "process" | "duplicate" | "in_progress" =
  "process";
let upsertEntitlementStateShouldFail = false;
let completeWebhookEventShouldFail = false;
let sendTransactionalEmailShouldFail = false;
let stripeWebhookEvent: StripeWebhookEvent = buildCompletedEvent();
let stripeMock = buildStripeMock();

mock.module("@/lib/access", () => ({
  fetchEntitlementByUserId: async () => existingEntitlement,
  withStripeCustomerEntitlementLock: async (
    _customerId: string,
    callback: (executor: object) => Promise<unknown>,
  ) => {
    const previous = lockTail;
    let release!: () => void;
    lockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback({});
    } finally {
      release();
    }
  },
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
  upsertEntitlementState: async (
    row: Record<string, unknown>,
    _executor: object,
    expectedSubscriptionId: string | null,
  ) => {
    callOrder.push("upsert_entitlement");
    if (upsertEntitlementStateShouldFail) {
      throw new Error("entitlement write failed");
    }
    if (associationChangesBeforeWrite) {
      existingEntitlement = {
        user_id: "user_123",
        stripe_subscription_id: "sub_concurrent",
      };
    }
    if (
      expectedSubscriptionId !== undefined &&
      (existingEntitlement?.stripe_subscription_id ?? null) !==
        expectedSubscriptionId
    ) {
      return null;
    }
    upsertEntitlementStateCalls.push(row);
    existingEntitlement = row;
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
  constructEventCalls.length = 0;
  callOrder.length = 0;
  beginWebhookEventResult = "process";
  upsertEntitlementStateShouldFail = false;
  completeWebhookEventShouldFail = false;
  sendTransactionalEmailShouldFail = false;
  stripeWebhookEvent = buildCompletedEvent();
  stripeMock = buildStripeMock();
  existingEntitlement = null;
  associationChangesBeforeWrite = false;
  retrievedSubscriptions = {};
  retrieveSubscriptionCalls.length = 0;
  lockTail = Promise.resolve();
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
  constructEventCalls.length = 0;
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

function buildInvoicePaidEvent(): StripeWebhookEvent {
  return {
    id: "evt_invoice_paid_123",
    type: "invoice.paid",
    data: {
      object: {
        id: "in_paid_123",
        customer: "cus_test_123",
        customer_email: "user@example.com",
        subscription: "sub_test_123",
      } as Stripe.Invoice,
    },
  } as StripeWebhookEvent;
}

function buildInvoicePaymentFailedEvent(): StripeWebhookEvent {
  return {
    id: "evt_invoice_failed_123",
    type: "invoice.payment_failed",
    data: {
      object: {
        id: "in_failed_123",
        customer: "cus_test_123",
        customer_email: "user@example.com",
        subscription: "sub_test_123",
      } as Stripe.Invoice,
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

function buildSubscription(
  overrides: Partial<Stripe.Subscription> = {},
): Stripe.Subscription {
  return {
    id: "sub_test_123",
    customer: "cus_test_123",
    metadata: { user_id: "user_123" },
    status: "active",
    created: 200,
    items: { data: [{ current_period_end: 1_900_000_000 }] },
    ...overrides,
  } as Stripe.Subscription;
}

function buildSubscriptionEvent(
  type: "customer.subscription.updated" | "customer.subscription.deleted",
  subscription: Stripe.Subscription,
): StripeWebhookEvent {
  return {
    id: `evt_${type}_${subscription.id}`,
    type,
    data: { object: subscription },
  } as StripeWebhookEvent;
}

function buildStripeMock() {
  return {
    webhooks: {
      constructEvent: (payload: string, signature: string, secret: string) => {
        constructEventCalls.push([payload, signature, secret]);
        return stripeWebhookEvent;
      },
    },
    subscriptions: {
      retrieve: async (id: string) => {
        retrieveSubscriptionCalls.push(id);
        return retrievedSubscriptions[id] ?? buildSubscription({ id });
      },
    },
    customers: {
      retrieve: async () => ({
        id: "cus_test_123",
        email: "user@example.com",
      }),
    },
  };
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
  test("reconciles a delayed active snapshot from current canceled provider state", async () => {
    stripeWebhookEvent = buildSubscriptionEvent(
      "customer.subscription.updated",
      buildSubscription(),
    );
    retrievedSubscriptions.sub_test_123 = buildSubscription({
      status: "canceled",
    });
    expect((await invokeWebhook()).status).toBe(200);
    expect(retrieveSubscriptionCalls).toEqual(["sub_test_123"]);
    expect(upsertEntitlementStateCalls[0]?.subscription_status).toBe(
      "canceled",
    );
  });

  test("does not replace a newer subscription binding when an older subscription is deleted", async () => {
    existingEntitlement = {
      user_id: "user_123",
      stripe_subscription_id: "sub_new",
      subscription_status: "active",
    };
    stripeWebhookEvent = buildSubscriptionEvent(
      "customer.subscription.deleted",
      buildSubscription({ id: "sub_old", status: "canceled" }),
    );
    retrievedSubscriptions.sub_old = buildSubscription({
      id: "sub_old",
      status: "canceled",
      created: 100,
    });
    expect((await invokeWebhook()).status).toBe(200);
    expect(existingEntitlement.stripe_subscription_id).toBe("sub_new");
    expect(existingEntitlement.subscription_status).toBe("active");
    expect(upsertEntitlementStateCalls).toHaveLength(0);
    expect(sendTransactionalEmailCalls).toHaveLength(0);
  });

  test("does not let a delayed old checkout replace the newer subscription", async () => {
    existingEntitlement = {
      user_id: "user_123",
      stripe_subscription_id: "sub_new",
      subscription_status: "active",
    };
    retrievedSubscriptions.sub_new = buildSubscription({
      id: "sub_new",
      created: 300,
    });
    expect((await invokeWebhook()).status).toBe(200);
    expect(upsertEntitlementStateCalls).toHaveLength(0);
    expect(existingEntitlement.stripe_subscription_id).toBe("sub_new");
    expect(sendTransactionalEmailCalls).toHaveLength(0);
  });

  test("allows a later checkout to replace a previous subscription", async () => {
    existingEntitlement = {
      user_id: "user_123",
      stripe_subscription_id: "sub_old",
      subscription_status: "canceled",
    };
    retrievedSubscriptions.sub_old = buildSubscription({
      id: "sub_old",
      status: "canceled",
      created: 100,
    });
    expect((await invokeWebhook()).status).toBe(200);
    expect(upsertEntitlementStateCalls[0]?.stripe_subscription_id).toBe(
      "sub_test_123",
    );
    expect(upsertEntitlementStateCalls[0]?.subscription_status).toBe("active");
  });

  test("handles invoice subscription links in the current Stripe API shape", async () => {
    stripeWebhookEvent = buildInvoicePaidEvent();
    stripeWebhookEvent.data.object = {
      id: "in_current",
      customer: "cus_test_123",
      customer_email: "user@example.com",
      parent: {
        type: "subscription_details",
        subscription_details: { subscription: "sub_test_123" },
      },
    } as Stripe.Invoice;
    expect((await invokeWebhook()).status).toBe(200);
    expect(upsertEntitlementStateCalls[0]?.current_period_ends_at).toBe(
      "2030-03-17T17:46:40.000Z",
    );
  });

  test("resolves a missing checkout customer from the authoritative subscription", async () => {
    (stripeWebhookEvent.data.object as Stripe.Checkout.Session).customer = null;
    expect((await invokeWebhook()).status).toBe(200);
    expect(upsertEntitlementStateCalls[0]?.stripe_customer_id).toBe(
      "cus_test_123",
    );
    expect(retrieveSubscriptionCalls).toEqual(["sub_test_123", "sub_test_123"]);
  });

  test("prefers current subscription item periods over legacy snapshots", async () => {
    retrievedSubscriptions.sub_test_123 = {
      ...buildSubscription(),
      current_period_end: 1_800_000_000,
    } as unknown as Stripe.Subscription;
    expect((await invokeWebhook()).status).toBe(200);
    expect(upsertEntitlementStateCalls[0]?.current_period_ends_at).toBe(
      "2030-03-17T17:46:40.000Z",
    );
  });

  test("retains legacy subscription period compatibility", async () => {
    retrievedSubscriptions.sub_test_123 = {
      ...buildSubscription(),
      items: { data: [] },
      current_period_end: 1_900_000_000,
    } as unknown as Stripe.Subscription;
    expect((await invokeWebhook()).status).toBe(200);
    expect(upsertEntitlementStateCalls[0]?.current_period_ends_at).toBe(
      "2030-03-17T17:46:40.000Z",
    );
  });

  test("retries a reconciliation whose association changed under another customer lock", async () => {
    associationChangesBeforeWrite = true;
    expect((await invokeWebhook()).status).toBe(400);
    expect(upsertEntitlementStateCalls).toHaveLength(0);
    expect(completeWebhookEventCalls).toHaveLength(0);
    expect(sendTransactionalEmailCalls).toHaveLength(0);
    expect(failWebhookEventCalls).toEqual([
      [
        "evt_completed_123",
        "Subscription association changed during reconciliation.",
      ],
    ]);
  });

  test("rejects authoritative customer mismatches before changing access", async () => {
    retrievedSubscriptions.sub_test_123 = buildSubscription({
      customer: "cus_unrelated",
    });
    expect((await invokeWebhook()).status).toBe(400);
    expect(upsertEntitlementStateCalls).toHaveLength(0);
    expect(completeWebhookEventCalls).toHaveLength(0);
  });

  test("uses authoritative status when metadata is absent and patches only the matching binding", async () => {
    stripeWebhookEvent = buildSubscriptionEvent(
      "customer.subscription.updated",
      buildSubscription(),
    );
    retrievedSubscriptions.sub_test_123 = buildSubscription({
      metadata: {},
      status: "canceled",
    });
    expect((await invokeWebhook()).status).toBe(200);
    expect(upsertEntitlementStateCalls).toHaveLength(0);
    expect(patchEntitlementByStripeSubscriptionIdCalls).toEqual([
      {
        stripeSubscriptionId: "sub_test_123",
        patch: {
          subscription_status: "canceled",
          stripe_customer_id: "cus_test_123",
          current_period_ends_at: "2030-03-17T17:46:40.000Z",
        },
      },
    ]);
  });

  test("serializes provider fetch and persistence for concurrent events", async () => {
    let finishFirst!: (subscription: Stripe.Subscription) => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let retrievals = 0;
    stripeMock = {
      ...buildStripeMock(),
      subscriptions: {
        retrieve: async () => {
          retrievals += 1;
          if (retrievals === 1) {
            firstStarted();
            return new Promise<Stripe.Subscription>((resolve) => {
              finishFirst = resolve;
            });
          }
          return buildSubscription({ status: "canceled" });
        },
      },
    } as never;
    stripeWebhookEvent = buildSubscriptionEvent(
      "customer.subscription.updated",
      buildSubscription(),
    );
    const first = invokeWebhook();
    await Promise.race([started, delay(100)]);
    expect(retrievals).toBe(1);
    stripeWebhookEvent = buildSubscriptionEvent(
      "customer.subscription.deleted",
      buildSubscription({ status: "canceled" }),
    );
    const second = invokeWebhook();
    await delay(10);
    expect(retrievals).toBe(1);
    finishFirst(buildSubscription());
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(existingEntitlement?.subscription_status).toBe("canceled");
  });

  test("passes raw webhook body, signature, and secret to Stripe verification", async () => {
    stripeWebhookEvent = buildCompletedEvent();

    const response = await invokeWebhook();

    expect(response.status).toBe(200);
    expect(constructEventCalls).toEqual([["{}", "sig_test", "whsec_test"]]);
  });

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

  test("syncs entitlement from invoice paid subscription before email", async () => {
    stripeWebhookEvent = buildInvoicePaidEvent();

    const response = await invokeWebhook();
    const payload = (await response.json()) as { received: boolean };

    expect(response.status).toBe(200);
    expect(payload).toEqual({ received: true });
    expect(upsertEntitlementStateCalls).toEqual([
      {
        user_id: "user_123",
        subscription_status: "active",
        stripe_customer_id: "cus_test_123",
        stripe_subscription_id: "sub_test_123",
        current_period_ends_at: "2030-03-17T17:46:40.000Z",
      },
    ]);
    expect(callOrder).toEqual([
      "begin_event",
      "upsert_entitlement",
      "complete_event",
      "send_email",
    ]);
  });

  test("syncs entitlement from payment failed invoice subscription before email", async () => {
    stripeWebhookEvent = buildInvoicePaymentFailedEvent();

    const response = await invokeWebhook();
    const payload = (await response.json()) as { received: boolean };

    expect(response.status).toBe(200);
    expect(payload).toEqual({ received: true });
    expect(upsertEntitlementStateCalls).toEqual([
      {
        user_id: "user_123",
        subscription_status: "active",
        stripe_customer_id: "cus_test_123",
        stripe_subscription_id: "sub_test_123",
        current_period_ends_at: "2030-03-17T17:46:40.000Z",
      },
    ]);
    expect(callOrder).toEqual([
      "begin_event",
      "upsert_entitlement",
      "complete_event",
      "send_email",
    ]);
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

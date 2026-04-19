import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildCheckoutSessionIdempotencyKey,
  createOrReuseCheckoutSession,
} from "./checkout";
import type { CheckoutSessionRow } from "./access";

const originalEnv = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
};
const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.SUPABASE_URL = "https://supabase.test";
  process.env.SUPABASE_ANON_KEY = "anon-key-test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
});

afterEach(() => {
  process.env.SUPABASE_URL = originalEnv.SUPABASE_URL;
  process.env.SUPABASE_ANON_KEY = originalEnv.SUPABASE_ANON_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = originalEnv.SUPABASE_SERVICE_ROLE_KEY;
  globalThis.fetch = originalFetch;
});

function buildReusableSession(
  overrides: Partial<CheckoutSessionRow> = {},
): CheckoutSessionRow {
  const now = new Date().toISOString();
  return {
    id: "checkout_session_123",
    checkout_context_key:
      "user_id:user_123|anonymous_trial_id:trial_123|install_id:install_123",
    user_id: "user_123",
    anonymous_trial_id: "trial_123",
    install_id: "install_123",
    stripe_checkout_session_id: "cs_test_123",
    stripe_customer_id: "cus_test_123",
    status: "open",
    checkout_url: "https://checkout.stripe.com/c/pay/cs_test_123",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("checkout session helper", () => {
  test("builds a deterministic idempotency key from the checkout context", () => {
    expect(
      buildCheckoutSessionIdempotencyKey({
        userId: "user_123",
        anonymousTrialId: "trial_123",
        installId: "install_123",
        monthlyPriceId: "price_monthly",
      }),
    ).toBe(
      "uttr_checkout|user_id:user_123|anonymous_trial_id:trial_123|install_id:install_123|price:price_monthly",
    );
  });

  test("reuses an open pending checkout session before calling Stripe", async () => {
    const reusableSession = buildReusableSession();
    let createCalls = 0;
    let insertCalls = 0;
    const stripe = {
      checkout: {
        sessions: {
          create: async () => {
            createCalls += 1;
            throw new Error("should not create a new session");
          },
        },
      },
    } as never;

    const result = await createOrReuseCheckoutSession({
      stripe,
      context: {
        userId: "user_123",
        anonymousTrialId: "trial_123",
        installId: "install_123",
        monthlyPriceId: "price_monthly",
        source: "direct",
        siteUrl: "https://uttr.test",
        userEmail: "user@example.com",
        stripeCustomerId: null,
      },
      dependencies: {
        fetchReusableOpenCheckoutSession: async () => reusableSession,
        insertPendingCheckoutSession: async () => {
          insertCalls += 1;
          return reusableSession;
        },
      },
    });

    expect(result).toEqual({
      url: reusableSession.checkout_url,
      checkoutSession: reusableSession,
      reused: true,
    });
    expect(createCalls).toBe(0);
    expect(insertCalls).toBe(0);
  });

  test("uses an existing Stripe customer when one is already stored", async () => {
    let capturedParams: unknown = null;
    let capturedOptions: unknown = null;
    const checkoutSession = {
      id: "cs_test_123",
      url: "https://checkout.stripe.com/c/pay/cs_test_123",
      customer: "cus_test_123",
      expires_at: Math.floor(Date.now() / 1000) + 3_600,
    } as const;
    const persistedSession = buildReusableSession({
      stripe_checkout_session_id: "cs_test_123",
      stripe_customer_id: "cus_test_123",
      checkout_url: checkoutSession.url,
    });
    const stripe = {
      checkout: {
        sessions: {
          create: async (params: unknown, options: unknown) => {
            capturedParams = params;
            capturedOptions = options;
            return checkoutSession;
          },
        },
      },
    } as never;

    await expect(
      createOrReuseCheckoutSession({
        stripe,
        context: {
          userId: "user_123",
          anonymousTrialId: "trial_123",
          installId: "install_123",
          monthlyPriceId: "price_monthly",
          source: "direct",
          siteUrl: "https://uttr.test",
          userEmail: "user@example.com",
          stripeCustomerId: "cus_existing_123",
        },
        dependencies: {
          fetchReusableOpenCheckoutSession: async () => null,
          insertPendingCheckoutSession: async (params) => {
            expect(params).toMatchObject({
              userId: "user_123",
              anonymousTrialId: "trial_123",
              installId: "install_123",
              stripeCheckoutSessionId: "cs_test_123",
              stripeCustomerId: "cus_test_123",
              checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_123",
            });
            return persistedSession;
          },
        },
      }),
    ).resolves.toEqual({
      url: persistedSession.checkout_url,
      checkoutSession: persistedSession,
      reused: false,
    });

    expect(capturedParams).toMatchObject({
      mode: "subscription",
      line_items: [{ price: "price_monthly", quantity: 1 }],
      success_url: "https://uttr.test/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://uttr.test/cancel",
      client_reference_id: "user_123",
      billing_address_collection: "auto",
      allow_promotion_codes: true,
      customer: "cus_existing_123",
    });
    expect(capturedParams).not.toHaveProperty("customer_email");
    expect(capturedOptions).toEqual({
      idempotencyKey:
        "uttr_checkout|user_id:user_123|anonymous_trial_id:trial_123|install_id:install_123|price:price_monthly",
    });
  });

  test("uses customer_email for first-time customers and fails safely when persistence fails", async () => {
    let createCalls = 0;
    let expireCalls = 0;
    let capturedParams: unknown = null;
    let capturedOptions: unknown = null;
    const stripe = {
      checkout: {
        sessions: {
          create: async (params: unknown, options: unknown) => {
            createCalls += 1;
            capturedParams = params;
            capturedOptions = options;
            return {
              id: "cs_test_456",
              url: "https://checkout.stripe.com/c/pay/cs_test_456",
              customer: null,
              expires_at: Math.floor(Date.now() / 1000) + 3_600,
            };
          },
          expire: async (sessionId: string) => {
            expireCalls += 1;
            expect(sessionId).toBe("cs_test_456");
          },
        },
      },
    } as never;

    await expect(
      createOrReuseCheckoutSession({
        stripe,
        context: {
          userId: "user_456",
          anonymousTrialId: "trial_456",
          installId: "install_456",
          monthlyPriceId: "price_monthly",
          source: "direct",
          siteUrl: "https://uttr.test",
          userEmail: "first@example.com",
          stripeCustomerId: null,
        },
        dependencies: {
          fetchReusableOpenCheckoutSession: async () => null,
          insertPendingCheckoutSession: async () => {
            throw new Error("persistence failed");
          },
        },
      }),
    ).rejects.toThrow("persistence failed");

    expect(createCalls).toBe(1);
    expect(expireCalls).toBe(1);
    expect(capturedParams).toMatchObject({
      customer_email: "first@example.com",
    });
    expect(capturedParams).not.toHaveProperty("customer");
    expect(capturedOptions).toEqual({
      idempotencyKey:
        "uttr_checkout|user_id:user_456|anonymous_trial_id:trial_456|install_id:install_456|price:price_monthly",
    });
  });
});

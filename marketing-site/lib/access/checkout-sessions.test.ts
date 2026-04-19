import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildPendingCheckoutSessionContextKey,
  fetchReusableOpenCheckoutSession,
  insertPendingCheckoutSession,
  markPendingCheckoutSessionCompleted,
  markPendingCheckoutSessionExpired,
} from "./supabase";
import type { CheckoutSessionRow } from "./types";

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

function buildSession(
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

describe("pending checkout session helpers", () => {
  test("builds a stable context key from user and install/claim context", () => {
    expect(
      buildPendingCheckoutSessionContextKey({
        userId: "user_123",
        anonymousTrialId: "trial_123",
        installId: "install_123",
      }),
    ).toBe(
      "user_id:user_123|anonymous_trial_id:trial_123|install_id:install_123",
    );

    expect(
      buildPendingCheckoutSessionContextKey({
        userId: "user_123",
        anonymousTrialId: null,
        installId: "install_123",
      }),
    ).toBe("user_id:user_123|anonymous_trial_id:null|install_id:install_123");
  });

  test("returns a reusable open session and ignores expired rows", async () => {
    const validSession = buildSession();
    const expiredSession = buildSession({
      id: "checkout_session_456",
      stripe_checkout_session_id: "cs_test_456",
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });

    let requestUrl = "";
    globalThis.fetch = async (input) => {
      requestUrl = String(input);
      return new Response(JSON.stringify([expiredSession, validSession]), {
        status: 200,
      });
    };

    await expect(
      fetchReusableOpenCheckoutSession({
        userId: "user_123",
        anonymousTrialId: "trial_123",
        installId: "install_123",
      }),
    ).resolves.toEqual(validSession);

    const url = new URL(requestUrl);
    expect(url.pathname).toBe("/rest/v1/checkout_sessions");
    expect(url.searchParams.get("checkout_context_key")).toBe(
      "eq.user_id:user_123|anonymous_trial_id:trial_123|install_id:install_123",
    );
    expect(url.searchParams.get("status")).toBe("eq.open");
  });

  test("inserts pending checkout rows with context key and Stripe ids", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const insertedSession = buildSession({ expires_at: expiresAt });
    let requestBody = "";
    globalThis.fetch = async (_input, init) => {
      requestBody = String(init?.body ?? "");
      return new Response(JSON.stringify([insertedSession]), { status: 201 });
    };

    await expect(
      insertPendingCheckoutSession({
        userId: "user_123",
        anonymousTrialId: "trial_123",
        installId: "install_123",
        stripeCheckoutSessionId: "cs_test_123",
        stripeCustomerId: "cus_test_123",
        checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_123",
        expiresAt,
      }),
    ).resolves.toEqual(insertedSession);

    expect(JSON.parse(requestBody)).toEqual({
      checkout_context_key:
        "user_id:user_123|anonymous_trial_id:trial_123|install_id:install_123",
      user_id: "user_123",
      anonymous_trial_id: "trial_123",
      install_id: "install_123",
      stripe_checkout_session_id: "cs_test_123",
      stripe_customer_id: "cus_test_123",
      status: "open",
      checkout_url: "https://checkout.stripe.com/c/pay/cs_test_123",
      expires_at: expiresAt,
    });
  });

  test("marks pending checkout sessions completed or expired by Stripe session id", async () => {
    let completionBody = "";
    let expirationBody = "";
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.searchParams.get("stripe_checkout_session_id") === "eq.cs_test_123") {
        completionBody = String(init?.body ?? "");
        return new Response(JSON.stringify([buildSession({ status: "completed" })]), {
          status: 200,
        });
      }

      expirationBody = String(init?.body ?? "");
      return new Response(JSON.stringify([buildSession({ status: "expired" })]), {
        status: 200,
      });
    };

    await expect(markPendingCheckoutSessionCompleted("cs_test_123")).resolves.toMatchObject({
      status: "completed",
    });
    await expect(markPendingCheckoutSessionExpired("cs_test_456")).resolves.toMatchObject({
      status: "expired",
    });

    expect(JSON.parse(completionBody)).toEqual({ status: "completed" });
    expect(JSON.parse(expirationBody)).toEqual({ status: "expired" });
  });
});

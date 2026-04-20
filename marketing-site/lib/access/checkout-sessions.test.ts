import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setDbExecutorForTests, type DbExecutor } from "@/lib/db";
import {
  buildPendingCheckoutSessionContextKey,
  fetchReusableOpenCheckoutSession,
  insertPendingCheckoutSession,
  markPendingCheckoutSessionCompleted,
  markPendingCheckoutSessionExpired,
} from "./postgres";
import type { CheckoutSessionRow } from "./types";

const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];

beforeEach(() => {
  queries.length = 0;
});

afterEach(() => {
  setDbExecutorForTests(null);
  queries.length = 0;
});

function mockDb<T>(handler: DbExecutor["query"]) {
  setDbExecutorForTests({
    query: async (sql, values) => {
      queries.push({ sql, values });
      return handler<T>(sql, values);
    },
  });
}

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

    mockDb<CheckoutSessionRow>(async () => ({
      rows: [expiredSession, validSession],
      rowCount: 2,
    }));

    await expect(
      fetchReusableOpenCheckoutSession({
        userId: "user_123",
        anonymousTrialId: "trial_123",
        installId: "install_123",
      }),
    ).resolves.toEqual(validSession);

    expect(queries[0].sql).toContain("from public.checkout_sessions");
    expect(queries[0].values?.[0]).toBe(
      "user_id:user_123|anonymous_trial_id:trial_123|install_id:install_123",
    );
  });

  test("inserts pending checkout rows with context key and Stripe ids", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const insertedSession = buildSession({ expires_at: expiresAt });
    mockDb<CheckoutSessionRow>(async () => ({
      rows: [insertedSession],
      rowCount: 1,
    }));

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

    expect(queries[0].sql).toContain("insert into public.checkout_sessions");
    expect(queries[0].values).toEqual([
        "user_id:user_123|anonymous_trial_id:trial_123|install_id:install_123",
      "user_123",
      "trial_123",
      "install_123",
      "cs_test_123",
      "cus_test_123",
      "open",
      "https://checkout.stripe.com/c/pay/cs_test_123",
      expiresAt,
    ]);
  });

  test("marks pending checkout sessions completed or expired by Stripe session id", async () => {
    mockDb<CheckoutSessionRow>(async (_sql, values) => ({
      rows: [
        buildSession({
          status: values?.[1] === "completed" ? "completed" : "expired",
        }),
      ],
      rowCount: 1,
    }));

    await expect(markPendingCheckoutSessionCompleted("cs_test_123")).resolves.toMatchObject({
      status: "completed",
    });
    await expect(markPendingCheckoutSessionExpired("cs_test_456")).resolves.toMatchObject({
      status: "expired",
    });

    expect(queries[0].values).toEqual(["cs_test_123", "completed"]);
    expect(queries[1].values).toEqual(["cs_test_456", "expired"]);
  });
});

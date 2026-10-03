import { afterEach, describe, expect, test } from "bun:test";
import { setDbExecutorForTests, type DbExecutor } from "@/lib/db";
import {
  fetchEntitlementByUserId,
  patchEntitlementByStripeSubscriptionId,
  upsertEntitlementState,
  withStripeCustomerEntitlementLock,
} from "./postgres";
import type { EntitlementRow } from "./types";

const row: EntitlementRow = {
  user_id: "user_123",
  subscription_status: "active",
  stripe_customer_id: "cus_123",
  stripe_subscription_id: "sub_123",
  current_period_ends_at: "2030-03-17T17:46:40.000Z",
  updated_at: "2026-10-02T00:00:00.000Z",
};

afterEach(() => setDbExecutorForTests(null));

describe("Stripe entitlement persistence", () => {
  test("acquires a durable customer lock before provider reconciliation", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const executor: DbExecutor = {
      query: async <T>(sql: string, values?: readonly unknown[]) => {
        calls.push({ sql, values });
        return { rows: [row] as T[], rowCount: 1 };
      },
    };
    setDbExecutorForTests(executor);

    await withStripeCustomerEntitlementLock(
      "cus_123",
      async (lockedExecutor) => {
        expect(lockedExecutor).toBe(executor);
        expect(calls).toEqual([
          {
            sql: "select pg_advisory_xact_lock(hashtext($1))",
            values: ["stripe_entitlement:cus_123"],
          },
        ]);
        await fetchEntitlementByUserId("user_123", lockedExecutor);
        await upsertEntitlementState(row, lockedExecutor, "sub_previous");
      },
    );

    expect(calls[1].values).toEqual(["user_123"]);
    expect(calls[2].sql).toContain(
      "where entitlements.stripe_subscription_id is not distinct from $6",
    );
    expect(calls[2].values).toEqual([
      "user_123",
      "active",
      "cus_123",
      "sub_123",
      row.current_period_ends_at,
      "sub_previous",
    ]);
  });

  test("uses a conditional null association for the first subscription", async () => {
    let queryValues: readonly unknown[] | undefined;
    const executor: DbExecutor = {
      query: async <T>(_sql: string, values?: readonly unknown[]) => {
        queryValues = values;
        return { rows: [row] as T[], rowCount: 1 };
      },
    };
    await expect(upsertEntitlementState(row, executor, null)).resolves.toEqual(
      row,
    );
    expect(queryValues?.[5]).toBeNull();
  });

  test("returns no entitlement when the conditional association changed", async () => {
    const executor: DbExecutor = {
      query: async () => ({ rows: [], rowCount: 0 }),
    };
    await expect(
      upsertEntitlementState(row, executor, "sub_previous"),
    ).resolves.toBeNull();
  });

  test("patches only the matching subscription through the transaction executor", async () => {
    let querySql = "";
    let queryValues: readonly unknown[] | undefined;
    const executor: DbExecutor = {
      query: async <T>(sql: string, values?: readonly unknown[]) => {
        querySql = sql;
        queryValues = values;
        return { rows: [row] as T[], rowCount: 1 };
      },
    };
    await patchEntitlementByStripeSubscriptionId(
      "sub_123",
      { subscription_status: "canceled" },
      executor,
    );
    expect(querySql).toContain("where stripe_subscription_id = $1");
    expect(queryValues).toEqual(["sub_123", "canceled"]);
  });
});

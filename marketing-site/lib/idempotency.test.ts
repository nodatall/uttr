import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setDbExecutorForTests, type DbExecutor } from "@/lib/db";
import {
  beginWebhookEvent,
  completeWebhookEvent,
  failWebhookEvent,
} from "./idempotency";

const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];

beforeEach(() => {
  queries.length = 0;
});

afterEach(() => {
  setDbExecutorForTests(null);
  queries.length = 0;
});

function mockDb(handler: DbExecutor["query"]) {
  setDbExecutorForTests({
    query: async (sql, values) => {
      queries.push({ sql, values });
      return handler(sql, values);
    },
  });
}

describe("webhook idempotency", () => {
  test("begins webhook processing through durable Postgres state", async () => {
    mockDb(async () => ({
      rows: [{ id: "evt_456" }],
      rowCount: 1,
    }));

    await expect(
      beginWebhookEvent("evt_456", "checkout.session.completed"),
    ).resolves.toBe("process");
    expect(queries[0].sql).toContain("insert into public.stripe_webhook_events");
    expect(queries[0].values).toEqual([
      "evt_456",
      "checkout.session.completed",
    ]);
  });

  test("parses duplicate and in-progress begin states", async () => {
    mockDb(async (_sql, values) => {
      if (String(_sql).includes("insert into")) {
        return { rows: [], rowCount: 0 };
      }

      return {
        rows: [
          {
            status: values?.[0] === "evt_123" ? "processed" : "processing",
            processing_started_at: new Date().toISOString(),
          },
        ],
        rowCount: 1,
      };
    });

    await expect(beginWebhookEvent("evt_123", "invoice.paid")).resolves.toBe(
      "duplicate",
    );

    await expect(beginWebhookEvent("evt_124", "invoice.paid")).resolves.toBe(
      "in_progress",
    );
  });

  test("completes webhook processing only after side effects finish", async () => {
    mockDb(async () => ({ rows: [], rowCount: 1 }));

    await expect(completeWebhookEvent("evt_done")).resolves.toBeUndefined();
    expect(queries[0].sql).toContain("status = 'processed'");
    expect(queries[0].values).toEqual(["evt_done"]);
  });

  test("marks failed webhook processing so Stripe retries are not suppressed", async () => {
    mockDb(async () => ({ rows: [], rowCount: 1 }));

    await expect(
      failWebhookEvent("evt_failed", new Error("entitlement write failed")),
    ).resolves.toBeUndefined();
    expect(queries[0].sql).toContain("status = 'failed'");
    expect(queries[0].values).toEqual([
      "evt_failed",
      "entitlement write failed",
    ]);
  });

  test("throws for unexpected persistence failures", async () => {
    mockDb(async () => {
      throw new Error("database unavailable");
    });

    await expect(beginWebhookEvent("evt_789", "invoice.paid")).rejects.toThrow(
      "database unavailable",
    );
  });
});

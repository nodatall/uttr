import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  beginWebhookEvent,
  completeWebhookEvent,
  failWebhookEvent,
} from "./idempotency";

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

describe("webhook idempotency", () => {
  test("begins webhook processing through the durable state RPC", async () => {
    let requestUrl = "";
    let requestBody = "";
    globalThis.fetch = async (input, init) => {
      requestUrl = String(input);
      requestBody = String(init?.body ?? "");
      return Response.json("process");
    };

    await expect(
      beginWebhookEvent("evt_456", "checkout.session.completed"),
    ).resolves.toBe("process");
    expect(requestUrl).toBe(
      "https://supabase.test/rest/v1/rpc/begin_stripe_webhook_event",
    );
    expect(JSON.parse(requestBody)).toEqual({
      p_event_id: "evt_456",
      p_event_type: "checkout.session.completed",
    });
  });

  test("parses duplicate and in-progress begin states", async () => {
    globalThis.fetch = async () =>
      Response.json([{ begin_stripe_webhook_event: "duplicate" }]);
    await expect(beginWebhookEvent("evt_123", "invoice.paid")).resolves.toBe(
      "duplicate",
    );

    globalThis.fetch = async () => Response.json("in_progress");
    await expect(beginWebhookEvent("evt_124", "invoice.paid")).resolves.toBe(
      "in_progress",
    );
  });

  test("completes webhook processing only after side effects finish", async () => {
    let requestUrl = "";
    let requestBody = "";
    globalThis.fetch = async (input, init) => {
      requestUrl = String(input);
      requestBody = String(init?.body ?? "");
      return new Response(null, { status: 204 });
    };

    await expect(completeWebhookEvent("evt_done")).resolves.toBeUndefined();
    expect(requestUrl).toBe(
      "https://supabase.test/rest/v1/rpc/complete_stripe_webhook_event",
    );
    expect(JSON.parse(requestBody)).toEqual({ p_event_id: "evt_done" });
  });

  test("marks failed webhook processing so Stripe retries are not suppressed", async () => {
    let requestUrl = "";
    let requestBody = "";
    globalThis.fetch = async (input, init) => {
      requestUrl = String(input);
      requestBody = String(init?.body ?? "");
      return new Response(null, { status: 204 });
    };

    await expect(
      failWebhookEvent("evt_failed", new Error("entitlement write failed")),
    ).resolves.toBeUndefined();
    expect(requestUrl).toBe(
      "https://supabase.test/rest/v1/rpc/fail_stripe_webhook_event",
    );
    expect(JSON.parse(requestBody)).toEqual({
      p_event_id: "evt_failed",
      p_error: "entitlement write failed",
    });
  });

  test("throws for unexpected persistence failures", async () => {
    globalThis.fetch = async () =>
      new Response("nope", { status: 500, statusText: "Internal Error" });

    await expect(beginWebhookEvent("evt_789", "invoice.paid")).rejects.toThrow(
      "Supabase RPC begin_stripe_webhook_event failed (500): nope",
    );
  });
});

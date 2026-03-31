import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerWebhookEvent } from "./idempotency";

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
  test("returns false when the webhook event already exists", async () => {
    globalThis.fetch = async () => new Response("", { status: 409 });

    await expect(registerWebhookEvent("evt_123", "invoice.paid")).resolves.toBe(
      false,
    );
  });

  test("returns true when the webhook event is recorded", async () => {
    let requestBody = "";
    globalThis.fetch = async (_input, init) => {
      requestBody = String(init?.body ?? "");
      return new Response("", { status: 201 });
    };

    await expect(registerWebhookEvent("evt_456", "checkout.session.completed")).resolves.toBe(
      true,
    );
    expect(requestBody).toContain("evt_456");
    expect(requestBody).toContain("checkout.session.completed");
  });

  test("throws for unexpected persistence failures", async () => {
    globalThis.fetch = async () =>
      new Response("nope", { status: 500, statusText: "Internal Error" });

    await expect(registerWebhookEvent("evt_789", "customer.subscription.deleted")).rejects.toThrow(
      "Failed to register webhook event evt_789 (500): nope",
    );
  });
});

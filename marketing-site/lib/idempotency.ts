import { readSupabaseConfig } from "@/lib/env";

export type WebhookEventBeginStatus = "process" | "duplicate" | "in_progress";

async function supabaseRpc<T>(name: string, body: Record<string, unknown>) {
  const { url, serviceRoleKey } = readSupabaseConfig();
  const response = await fetch(new URL(`/rest/v1/rpc/${name}`, url), {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Supabase RPC ${name} failed (${response.status}): ${text || response.statusText}`,
    );
  }

  if (response.status === 204) {
    return null as T;
  }

  const text = await response.text();
  if (!text) {
    return null as T;
  }

  return JSON.parse(text) as T;
}

function parseBeginStatus(payload: unknown): WebhookEventBeginStatus {
  const value = Array.isArray(payload) ? payload[0] : payload;
  const status =
    typeof value === "string"
      ? value
      : value &&
          typeof value === "object" &&
          "begin_stripe_webhook_event" in value
        ? (value as { begin_stripe_webhook_event?: unknown })
            .begin_stripe_webhook_event
        : null;

  if (
    status === "process" ||
    status === "duplicate" ||
    status === "in_progress"
  ) {
    return status;
  }

  throw new Error("Supabase webhook idempotency RPC returned an invalid status.");
}

export async function beginWebhookEvent(
  eventId: string,
  eventType: string,
) {
  const payload = await supabaseRpc<unknown>("begin_stripe_webhook_event", {
    p_event_id: eventId,
    p_event_type: eventType,
  });

  return parseBeginStatus(payload);
}

export async function completeWebhookEvent(eventId: string) {
  await supabaseRpc<null>("complete_stripe_webhook_event", {
    p_event_id: eventId,
  });
}

export async function failWebhookEvent(eventId: string, error: unknown) {
  await supabaseRpc<null>("fail_stripe_webhook_event", {
    p_event_id: eventId,
    p_error:
      error instanceof Error ? error.message : "Unknown webhook processing error",
  });
}

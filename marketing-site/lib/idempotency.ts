import { readSupabaseConfig } from "@/lib/env";

type WebhookEventRecord = {
  id: string;
  event_type: string;
};

export async function registerWebhookEvent(
  eventId: string,
  eventType: string,
) {
  const { url, serviceRoleKey } = readSupabaseConfig();
  const response = await fetch(
    `${url}/rest/v1/stripe_webhook_events`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify({
        id: eventId,
        event_type: eventType,
      } satisfies WebhookEventRecord),
    },
  );

  if (response.status === 409) {
    return false;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to register webhook event ${eventId} (${response.status}): ${body || response.statusText}`,
    );
  }

  return true;
}

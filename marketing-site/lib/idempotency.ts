import { dbQuery, dbTransaction } from "@/lib/db";

export type WebhookEventBeginStatus = "process" | "duplicate" | "in_progress";

function parseBeginStatus(payload: unknown): WebhookEventBeginStatus {
  if (
    payload === "process" ||
    payload === "duplicate" ||
    payload === "in_progress"
  ) {
    return payload;
  }

  throw new Error("Webhook idempotency store returned an invalid status.");
}

export async function beginWebhookEvent(eventId: string, eventType: string) {
  return dbTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `insert into public.stripe_webhook_events (
         id,
         event_type,
         status,
         processing_started_at,
         processed_at,
         last_error,
         updated_at
       )
       values ($1, $2, 'processing', now(), null, null, now())
       on conflict (id) do nothing
       returning id`,
      [eventId, eventType],
    );

    if (inserted.rows[0]) {
      return "process";
    }

    const existing = await client.query<{
      status: string;
      processing_started_at: string | Date | null;
    }>(
      `select status, processing_started_at
         from public.stripe_webhook_events
        where id = $1
        for update`,
      [eventId],
    );
    const row = existing.rows[0];
    if (!row) {
      return "process";
    }

    if (row.status === "processed") {
      return "duplicate";
    }

    const startedAtMs = row.processing_started_at
      ? new Date(row.processing_started_at).getTime()
      : 0;
    if (row.status === "processing" && startedAtMs > Date.now() - 600_000) {
      return "in_progress";
    }

    await client.query(
      `update public.stripe_webhook_events
          set event_type = $2,
              status = 'processing',
              processing_started_at = now(),
              processed_at = null,
              last_error = null,
              updated_at = now()
        where id = $1`,
      [eventId, eventType],
    );

    return parseBeginStatus("process");
  });
}

export async function completeWebhookEvent(eventId: string) {
  await dbQuery(
    `update public.stripe_webhook_events
        set status = 'processed',
            processed_at = now(),
            processing_started_at = null,
            last_error = null,
            updated_at = now()
      where id = $1`,
    [eventId],
  );
}

export async function failWebhookEvent(eventId: string, error: unknown) {
  await dbQuery(
    `update public.stripe_webhook_events
        set status = 'failed',
            processing_started_at = null,
            last_error = left($2, 2000),
            updated_at = now()
      where id = $1`,
    [
      eventId,
      error instanceof Error
        ? error.message
        : "Unknown webhook processing error",
    ],
  );
}

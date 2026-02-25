const eventRegistry = new Map<string, number>();
const TTL_MS = 1000 * 60 * 60 * 24;

function cleanup(now: number) {
  for (const [eventId, timestamp] of eventRegistry.entries()) {
    if (now - timestamp > TTL_MS) {
      eventRegistry.delete(eventId);
    }
  }
}

export function registerWebhookEvent(eventId: string) {
  const now = Date.now();
  cleanup(now);

  if (eventRegistry.has(eventId)) {
    return false;
  }

  eventRegistry.set(eventId, now);
  return true;
}

# Final Review: billing-recovery-hardening

## scope

Full branch review for the one-shot billing recovery hardening run.

## findings

### [P1] Webhook event registration happens before irreversible side effects

- file: `marketing-site/app/api/stripe/webhook/route.ts`
- review result: fixed
- action: replaced pre-side-effect event registration with durable webhook event processing states. The webhook route now begins a processing claim, returns duplicate only for completed events, returns retryable `409` for still-processing concurrent deliveries, completes the event only after side effects succeed, and marks failures retryable.
- verification: `cd marketing-site && bun test lib/idempotency.test.ts app/api/stripe/webhook/route.test.ts`; `cd marketing-site && bun test`; `cd marketing-site && npm run lint`; `cd marketing-site && npm run build`.

### [P2] Concurrent checkout retries can expire the session another request already returned

- file: `marketing-site/lib/checkout.ts`
- review result: fixed
- action: removed the fallback that expired a Stripe Checkout Session after pending-session persistence failed. Because the creation call uses a deterministic idempotency key, the helper now rechecks for a reusable persisted session and otherwise fails without expiring a possibly shared session.
- verification: `cd marketing-site && bun test lib/checkout.test.ts`; `cd marketing-site && bun test`; `cd marketing-site && npm run lint`; `cd marketing-site && npm run build`.

### [P1] Completion failure replays already-applied webhook work

- file: `marketing-site/app/api/stripe/webhook/route.ts`
- review result: fixed
- action: moved transactional email work to post-commit side effects. Critical persistence now completes before webhook event completion; if completion bookkeeping fails, no email has been sent yet and the event can safely retry idempotent persistence. If post-commit email fails after completion, the route logs it without reopening the processed webhook event.
- verification: `cd marketing-site && bun test app/api/stripe/webhook/route.test.ts`; `cd marketing-site && bun test`; `cd marketing-site && npm run lint`; `cd marketing-site && npm run build`.

## residual risk

- Live Stripe/Supabase staging probes were not run in this local review round.
- Desktop install/open and signed activation paths remain unverified in this web/billing-focused execution.

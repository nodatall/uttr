# Billing Recovery Hardening TDD

## Plain-Language Summary

The fix adds real memory to checkout and makes the billing path choose based on the user's actual account state. When checkout starts, the server records the pending Stripe session so retries can reuse it instead of creating duplicates.

The desktop app will stop treating every non-subscribed state as "make a new first-purchase claim." It will show the right recovery action for linked billing states and will only use the install-origin token flow when the server can still tie checkout back to the Uttr install.

The claim page and rate limiter will become stricter. Claim conversion will return clear machine-readable outcomes, and production rate limits will use durable storage instead of one Node process's memory.

## Technical Summary

Implement four related changes:

1. Split billing UI decisions between first-purchase install-origin checkout and linked-account recovery.
2. Persist pending Stripe Checkout Sessions in Supabase and reuse them for duplicate/retry requests.
3. Replace ambiguous `convert-anonymous` 409 tolerance with explicit conversion statuses and matching claim-page behavior.
4. Add a production-durable rate-limit path, keeping the existing in-memory implementation only for tests/local fallback.

Stripe guidance used for the design: Checkout remains the right subscription payment frontend, Stripe Customer Portal is the right self-service management surface, subscription provisioning must be driven by webhooks, and existing Customer IDs should be reused for subsequent sessions.

## Scope Alignment to PRD

- `FR-001`, `FR-005`: Checkout remains server-authorized and webhook-provisioned.
- `FR-002`, `FR-007`: Desktop and account/claim UI route linked non-active states to actionable billing recovery.
- `FR-003`: Supabase pending checkout persistence plus Stripe idempotency keys prevent duplicate sessions.
- `FR-004`: Conversion route and claim page use explicit statuses.
- `FR-006`: Rate limiting has a durable production store.

## Current Technical Diagnosis

Relevant existing surfaces:

- Desktop billing UI: `src/components/settings/UpgradeButton.tsx`, `src/components/settings/ManageSubscriptionButton.tsx`, `src/components/Sidebar.tsx`.
- Desktop/backend access state: `src-tauri/src/access.rs`, `src-tauri/src/settings.rs`, `src/stores/settingsStore.ts`, generated `src/bindings.ts`.
- Claim and checkout routes: `marketing-site/app/(site)/claim/claim-flow.tsx`, `marketing-site/app/api/auth/convert-anonymous/route.ts`, `marketing-site/app/api/trial/create-claim/route.ts`, `marketing-site/app/api/checkout/route.ts`.
- Billing portal route: `marketing-site/app/api/billing/portal/route.ts`.
- Supabase access helpers and schema: `marketing-site/lib/access/supabase.ts`, `marketing-site/lib/access/types.ts`, `marketing-site/supabase/migrations/*`.
- Rate limiting: `marketing-site/lib/rate-limit.ts`, route callers in trial bootstrap, claim creation, and cloud transcription.

Validation surface:

- Root: `bun run lint`, `bun run build`, `bun run check:translations`.
- Marketing site: `bun test`, `npm run lint`, `npm run build`.
- Rust targeted tests can run via `cargo test access --quiet`.
- Full `cargo test --quiet` and `bun run format:check` are known not-clean from the sweep and are not release gates for this scoped fix unless repaired separately.

## Architecture / Approach

### Billing State Selection

Keep a small, explicit frontend decision layer instead of burying billing state in button conditionals:

- Subscribed or active entitlement: show account management only.
- `past_due`: show an update-payment/account action that opens `/account` and lets the signed-in account reach Stripe Customer Portal; do not create a first-purchase checkout session from the desktop button.
- `canceled` or entitlement `expired`: show a reactivation checkout action. The server must use the existing Stripe customer when it has one and must keep checkout install-origin bound.
- entitlement `inactive` with `trial_state === "linked"`: show app-origin checkout retry/reactivation. This is still install-origin gated, but it must not depend on the old "unlinked only" claim eligibility rule.
- unlinked `new`, `trialing`, or expired trial: keep the current app-origin claim checkout path.

The desktop cannot authenticate as the user's Supabase account, so account-specific Stripe decisions still happen in the browser after sign-in. The desktop's job is to choose the right entry URL and avoid impossible local token calls.

### Pending Checkout Persistence

Add Supabase storage for open checkout attempts. The server should key pending checkout by the stable internal ownership tuple available at request time:

- `user_id`
- `anonymous_trial_id`
- `install_id`
- Stripe Checkout Session ID
- Stripe Customer ID when known
- status such as `open`, `completed`, `expired`
- `expires_at`

Before creating a new Checkout Session, lookup a reusable open session for the same user and install/claim context. If present and not expired, return its URL. Otherwise create a new session with a deterministic Stripe idempotency key for the current checkout attempt, persist it, and return the URL. The schema or helper layer must enforce at most one open pending checkout for a user/install context; implementation can use a partial unique index, a claim-context uniqueness key, an atomic RPC, or an equivalent service-role guarded operation.

When an entitlement already has `stripe_customer_id`, Checkout Session creation must pass `customer`. Only first-time customers without a stored Stripe customer should use `customer_email`.

### Claim Conversion

Use explicit server statuses instead of treating all 409s as safe:

- `linked`: claim was freshly redeemed for the current user.
- `already_linked_same_user`: claim/install already belongs to the current user and checkout can continue when token and expiry are valid.
- `already_linked_different_user`: stop.
- `expired_claim`: stop and tell the user to reopen checkout from Uttr.
- `invalid_claim`: stop.
- `already_entitled`: redirect to success/account instead of starting a new checkout.

Execution may choose exact field names during implementation, but the response must be machine-readable and covered by tests.

The install-origin token creation route must also support recoverable linked installs. The current `trialCanCreateClaim` helper or equivalent route contract must stop rejecting every linked trial. It should allow a linked install to mint a recovery/checkout token only when the entitlement is not active and the browser-authenticated conversion step can later prove the signed-in user matches the linked trial user. Wrong-user conversion remains blocked.

### Production Rate Limiting

Replace the production store behind the existing rate-limit policy with durable storage unless implementation finds a simpler already-installed production store. Keep an in-memory implementation for local tests and development only. In production, if the durable limiter cannot be configured or reached, public expensive routes must return a conservative retryable error instead of silently falling back to memory.

## System Boundaries / Source of Truth

- Stripe is the source of truth for subscription lifecycle and Checkout/Portal URLs.
- Supabase entitlements are Uttr's local source of truth for app access.
- Supabase pending checkout rows are the source of truth for in-flight checkout dedupe.
- Browser success pages are informational only; entitlement changes come from webhook processing.
- The desktop app stores install and entitlement snapshots but must refresh before making billing UI decisions.

## Dependencies

- Stripe Checkout Sessions API in subscription mode.
- Stripe Customer Portal.
- Stripe webhook events including `checkout.session.completed`, `checkout.session.expired` when available, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, and `customer.subscription.deleted`.
- Supabase REST/RPC via service role for backend-only persistence.
- Existing Bun test runner for marketing-site unit tests.

## Route / API / Public Interface Changes

- `/api/auth/convert-anonymous`: return explicit conversion status values and stop collapsing materially different 409s.
- `/api/checkout`: reuse pending sessions, use stored customer IDs when available, return existing checkout URL when appropriate, and maintain current no-token rejection for naked checkout.
- `/api/trial/create-claim`: allow a safe install-origin retry/recovery token for linked non-active installs when checkout can still be bound to that install and current user after browser auth.
- Public route callers using rate limiting must await or otherwise support durable rate-limit checks.

## Data Model / Schema / Storage Changes

Add a Supabase migration for pending checkout sessions, likely `public.checkout_sessions`:

- `id uuid primary key default gen_random_uuid()`
- `user_id uuid not null references public.profiles(id)`
- `anonymous_trial_id uuid null references public.anonymous_trials(id)`
- `install_id text null`
- `stripe_checkout_session_id text not null unique`
- `stripe_customer_id text null`
- `status text not null` with allowed values `open`, `completed`, `expired`
- `checkout_url text not null`
- `expires_at timestamptz not null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Add indexes for `user_id`, `anonymous_trial_id`, `install_id`, `status`, and `expires_at`. Enable RLS; service-role backend writes remain the intended access path.

Add durable rate-limit storage selected during implementation. A Supabase table/RPC is acceptable and likely, but the required contract is durable, atomic-enough per route/IP key, production-enabled, and covered by failure-mode tests.

## Technical Requirements

- `TDR-001` Desktop billing UI must use a shared billing-state decision instead of independent button conditionals that conflict.
- `TDR-002` Linked non-active install recovery must not depend on a claim endpoint that rejects all linked trials.
- `TDR-003` Checkout route must persist and reuse open checkout sessions for the same user/install retry window.
- `TDR-004` Checkout route must pass existing `stripe_customer_id` as `customer` when available and only use `customer_email` for first-time customers.
- `TDR-005` Stripe session creation must use a deterministic idempotency key for the deduped checkout attempt.
- `TDR-006` Webhook handling must mark checkout pending rows complete or expired when Stripe sends the relevant event.
- `TDR-007` Claim conversion must expose typed outcomes that the claim page handles explicitly.
- `TDR-008` Production rate limiting must use durable storage or fail closed when durable configuration is missing.
- `TDR-009` Tests must cover same-user retry, wrong-user/token conflict, duplicate checkout reuse, completed pending checkout, and production rate-limit behavior.
- `TDR-010` Existing no-token checkout, webhook signature, and install-token protections must remain covered.
- `TDR-011` Pending checkout persistence must enforce one open pending checkout per user/install context and must test concurrent/repeated request behavior at the helper or route level.

## Ingestion / Backfill / Migration / Rollout Plan

- Add migrations before route behavior depends on new tables/RPCs.
- Existing users without pending checkout rows require no backfill.
- Existing entitlements continue to drive access. Pending checkout rows are only for new attempts after deploy.
- If the pending checkout migration fails, checkout route should not silently create unlimited sessions as a fallback in production.

## Failure Modes / Recovery / Rollback

- If a pending checkout row exists but is expired, the route should mark or treat it as expired and create a new session.
- If Stripe returns no URL, do not persist an unusable open row.
- If Supabase pending-session persistence fails in production, return a safe error instead of creating a duplicate-prone session.
- If rate-limit durable storage fails in production, public expensive routes must return a conservative retryable error rather than bypassing limits.
- Rollback must leave existing entitlement and trial tables compatible. New tables can remain unused after rollback.

## Operational Readiness

- Log checkout reuse, checkout creation, pending persistence failure, conversion conflicts, and durable rate-limit failures with structured events.
- Keep Stripe secret keys and Supabase service-role keys server-only.
- Keep all checkout and billing routes on the Node runtime.
- Do not expose claim tokens or install tokens in server logs.

## Verification and Test Strategy

Targeted tests:

- Marketing-site unit tests for checkout session persistence helpers and checkout route behavior with mocked Stripe/fetch.
- Checkout tests must assert `customer` is used when an entitlement has `stripe_customer_id`, `customer_email` is used only for first-time customers, and repeated same-context calls do not create a second open pending session.
- Claim conversion tests for same-user retry, wrong-user, expired, and invalid outcomes.
- Claim creation tests must cover linked non-active token minting and active/subscribed rejection.
- Rate-limit tests for durable-store selection, production fail-closed behavior, and header trust behavior.
- Desktop UI tests where practical for billing-state decision helpers; otherwise component-level tests or focused logic tests for button visibility/actions.

Commands:

- `cd marketing-site && bun test`
- `cd marketing-site && npm run lint`
- `cd marketing-site && npm run build`
- `bun run lint`
- `bun run build`
- `bun run check:translations`
- Targeted Rust access tests only if Rust access state changes.

Manual/browser/API probes:

- `/claim` without token remains download-first.
- Signed-out checkout still fails.
- Duplicate checkout calls with the same token return the same URL in mocked/integration evidence.
- Linked non-active desktop state opens an actionable account/checkout path.

# TDD: Anonymous Trial + Landing-Page Checkout + Backend-Proxy Cloud

## Plain-Language Summary

The current desktop app talks to Groq directly, which means a built-in Uttr Groq key would leak. The fix is to move default cloud transcription behind a backend proxy that lives in the existing `marketing-site` codebase. That same deployment also becomes the source of truth for trial state, Stripe-backed subscription entitlement, claim-token handoff from the app to the website, and billing portal access. The deployment target changes from Vercel to Fly.io so the proxy can accept real audio uploads.

## Technical Summary

Deploy `marketing-site` to Fly.io as a standalone Next.js Node server. Add Supabase-backed route handlers for trial bootstrap, cloud transcription proxying, entitlement reads, trial claim creation, anonymous-to-account linking, checkout session creation, Stripe webhook ingestion, and billing-portal session creation. In the desktop app, replace default direct Groq calls with the proxy path, store install identity locally, store BYOK secrets in Tauri Stronghold, remove visible Groq-key onboarding, auto-download Parakeet V3, and enforce routing rules of `BYOK -> paid -> anonymous trial -> blocked`.

## Scope Alignment to PRD

- Supports `FR-001` with a server-backed anonymous trial state keyed by install identity.
- Supports `FR-002` by moving default Groq traffic behind a backend proxy.
- Supports `FR-003` and `FR-004` by using the existing `marketing-site` codebase and redeploying it on Fly.io.
- Supports `FR-005` with claim-token generation and landing-page conversion flows.
- Supports `FR-006` and `FR-009` with durable entitlement and webhook-event persistence in Supabase.
- Supports `FR-007` and `FR-008` with onboarding changes plus hidden BYOK backed by secure secret storage.
- Supports `FR-010` with audio-path preservation and timing telemetry.

## Current Technical Diagnosis

### Desktop

- `src-tauri/src/groq_client.rs` builds a WAV in-process and sends it directly to Groq with a client-held bearer token.
- `src-tauri/src/managers/transcription.rs` already has cloud/local fallback logic hooks that can be extended into the new access router.
- `src-tauri/src/managers/model.rs` already treats `parakeet-tdt-0.6b-v3` as the default local model.
- `src/components/onboarding/Onboarding.tsx` currently makes model choice and Groq key configuration part of first-run UX.
- `src/components/settings/api-keys/ApiKeysSettings.tsx` treats Groq key entry as a normal visible setting.
- The app currently has `tauri-plugin-store` but no secure secret storage plugin for BYOK.

### Website / backend

- `marketing-site` already runs a Next.js App Router app with Stripe Checkout and Stripe webhooks.
- Current webhook idempotency in `marketing-site/lib/idempotency.ts` is process-local memory and must be replaced with durable storage.
- `marketing-site` currently has no entitlement tables, no desktop claim flow, and no audio proxy endpoints.

### Hosting

- Vercel’s documented `4.5 MB` Function request-body cap makes it unsuitable for the audio proxy path.
- Next.js supports standalone output for self-hosted/serverful deployment.
- Fly.io supports running a normal Next.js deployment from the same codebase.

## Architecture Decision

### Chosen shape

Use a single deployed Next.js monolith on Fly.io:

- public website
- auth pages
- checkout endpoints
- Stripe webhook endpoint
- billing portal endpoint
- anonymous trial endpoints
- cloud transcription proxy endpoint
- entitlement lookup endpoint

This is simpler than a separate backend service, preserves the existing website codebase, and removes the Vercel request-body constraint.

### Explicitly rejected shape

- Keep Vercel and add proxy endpoints there.
  - Rejected because the request-body cap is incompatible with the proxy workload.
- Build a separate backend service now.
  - Rejected because it adds infra, auth duplication, and rollout complexity without solving a product problem that the same Next.js codebase cannot handle.

## Deployment Architecture

### Runtime

- Add `output: "standalone"` to `marketing-site/next.config.ts`.
- Add a production Dockerfile for `marketing-site`.
- Deploy the image to Fly.io as one app.
- Force proxy and webhook routes onto the Node runtime.
- Start with a single US region deployment and scale only after latency data.

### Environment

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `NEXT_PUBLIC_STRIPE_PRICE_ID_MONTHLY`
- `NEXT_PUBLIC_SITE_URL`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GROQ_API_KEY`
- `GROQ_TRANSCRIPTION_MODEL_DEFAULT`
- `UTTR_INSTALL_TOKEN_SECRET`
- `UTTR_CLAIM_TOKEN_SECRET`

## Identity and Access Model

### Install identity

The desktop app owns two local identifiers:

- `install_id`: randomly generated UUID, stable for the install
- `device_fingerprint_hash`: deterministic hash used only for abuse deterrence and heuristics

The app stores both locally with the normal settings/store path.

### Install token

`POST /api/trial/bootstrap` returns a signed `install_token` that is bound to:

- `anonymous_trial_id`
- `install_id`
- `device_fingerprint_hash`

The desktop app stores `install_token` locally and presents it to backend routes as the credential for install-linked state.

### Account linkage

- `anonymous_trials.user_id` starts as `NULL`.
- When the user reaches the landing page and authenticates, `POST /api/auth/convert-anonymous` links the claimed install to the authenticated `profiles.id`.
- From that point on, access decisions for that install can resolve through the linked user’s `entitlements` row.

This keeps the desktop runtime simple: the app does not need full web auth session management to regain access after purchase.

## Data Model

### `profiles`

Backed by Supabase Auth user IDs.

Fields:

- `id uuid primary key`
- `email text not null`
- `created_at timestamptz not null default now()`
- `byok_unlocked boolean not null default false`

### `anonymous_trials`

Fields:

- `id uuid primary key`
- `install_id text not null unique`
- `device_fingerprint_hash text not null`
- `user_id uuid null references profiles(id)`
- `status text not null`
- `trial_started_at timestamptz null`
- `trial_ends_at timestamptz null`
- `last_seen_at timestamptz not null default now()`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Allowed status values:

- `new`
- `trialing`
- `expired`
- `linked`

### `trial_claims`

Fields:

- `id uuid primary key`
- `anonymous_trial_id uuid not null references anonymous_trials(id)`
- `claim_token_hash text not null unique`
- `expires_at timestamptz not null`
- `redeemed_at timestamptz null`
- `created_at timestamptz not null default now()`

### `entitlements`

Fields:

- `user_id uuid primary key references profiles(id)`
- `subscription_status text not null`
- `stripe_customer_id text null`
- `stripe_subscription_id text null`
- `current_period_ends_at timestamptz null`
- `updated_at timestamptz not null default now()`

Allowed status values:

- `inactive`
- `active`
- `past_due`
- `canceled`
- `expired`

### `usage_events`

Fields:

- `id uuid primary key`
- `anonymous_trial_id uuid null references anonymous_trials(id)`
- `user_id uuid null references profiles(id)`
- `source text not null`
- `audio_seconds integer not null`
- `created_at timestamptz not null default now()`

Allowed source values:

- `cloud_default`
- `cloud_byok`
- `local_fallback`

### `stripe_webhook_events`

Fields:

- `id text primary key`
- `event_type text not null`
- `processed_at timestamptz not null default now()`

This replaces process-local webhook idempotency.

## Backend Routes

### `POST /api/trial/bootstrap`

Request:

- `install_id`
- `device_fingerprint_hash`
- `app_version`

Behavior:

- Create or fetch `anonymous_trials` by `install_id`.
- Refresh `last_seen_at`.
- If `trial_ends_at` is in the past and status is `trialing`, mark `expired`.
- Return a signed `install_token`.
- Do not start the trial if the row is still `new`.

Response DTO:

- `trial_state`
- `access_state`
- `install_token`

### `POST /api/transcribe/cloud`

Request:

- Bearer or header `install_token`
- multipart body:
  - `file`
  - `model`
  - `language`
  - `translate_to_english`

Behavior:

- Validate `install_token`.
- Resolve access in this order:
  - linked paid entitlement
  - anonymous trial eligibility
- If `status = new`, start trial and set `trial_started_at` plus `trial_ends_at = now() + interval '48 hours'`.
- If trial is expired and linked entitlement is inactive, return blocked.
- Reject payloads above the current enforced upload cap of `25 MB`.
- Forward to Groq using server-held `GROQ_API_KEY`.
- Preserve WAV and 16 kHz mono path from the desktop app.
- Record timing metrics and a `usage_events` row.

Response DTO:

- `text`
- `timings`
- `trial_state`
- `access_state`

### `POST /api/trial/create-claim`

Request:

- `install_token`

Behavior:

- Validate install token.
- Require current access decision to be blocked due to expired unpaid state.
- Create a short-lived single-use claim token with `15 minute` TTL.
- Store only the claim-token hash.

Response DTO:

- `claim_token`
- `claim_url`
- `expires_at`

### `POST /api/auth/convert-anonymous`

Authenticated website route.

Request:

- `claim_token`

Behavior:

- Validate current Supabase user.
- Hash and look up the claim token.
- Require unexpired, unredeemed claim.
- Link `anonymous_trials.user_id` to the current user.
- Mark claim as redeemed.
- Mark `anonymous_trials.status = linked`.

Response DTO:

- `linked`
- `user_id`
- `has_active_entitlement`

### `POST /api/checkout`

Authenticated website route.

Request:

- optional `claim_token`
- optional `source`

Behavior:

- Require authenticated user.
- Ensure the install claim is already linked if a claim token is present.
- Create a Stripe subscription Checkout Session.
- Include `user_id`, `anonymous_trial_id`, and `install_id` in session metadata when available.

### `POST /api/stripe/webhook`

Behavior:

- Verify Stripe signature.
- Persist `event.id` to `stripe_webhook_events` before side effects.
- Ignore duplicates based on durable storage.
- Upsert `entitlements` from:
  - `checkout.session.completed`
  - `invoice.paid`
  - `invoice.payment_failed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`

### `POST /api/billing/portal`

Authenticated website route.

Behavior:

- Read the linked Stripe customer ID from `entitlements`.
- Create a Stripe customer-portal session.
- Return the portal URL.

### `GET /api/entitlement`

Request:

- `install_token`

Behavior:

- Resolve install -> user linkage.
- Return access decision based on:
  - valid BYOK flag from the app is not evaluated here
  - active paid entitlement if linked
  - trialing if anonymous trial active
  - blocked otherwise

Response DTO:

- `access_state`
- `trial_state`
- `entitlement_state`

## Desktop Changes

### New local state

- `install_id`
- `device_fingerprint_hash`
- `install_token`
- `anonymous_trial_state`
- `access_state`
- hidden `byok_enabled`
- hidden `byok_validation_state`

### Secret storage

- Add Tauri Stronghold.
- Move BYOK Groq key out of plain settings storage into Stronghold.
- Keep normal non-secret routing flags in existing settings storage.

### Transcription routing

Decision order:

1. If hidden BYOK is enabled and validation status is valid, call Groq directly with the user’s key.
2. Else if `access_state = subscribed`, call `/api/transcribe/cloud`.
3. Else if `access_state = trialing`, call `/api/transcribe/cloud`.
4. Else block and open paywall claim flow.

### Onboarding

- Remove visible Groq key entry.
- Remove visible model-choice-first onboarding.
- Replace with:
  - permissions
  - simple intro
  - immediate ready state
  - background Parakeet V3 download

### Settings

- Remove Groq key from normal `API Keys` settings for the default cloud path.
- Add a hidden version-tap gesture to reveal BYOK controls.
- Keep model settings focused on visibility appropriate to the new product defaults.

## Landing Page Flow

### Expired-trial flow

1. Desktop tries to transcribe.
2. Backend returns blocked.
3. Desktop calls `/api/trial/create-claim`.
4. Desktop opens landing page claim URL in browser.
5. Website requires sign-in or account creation.
6. Website links the claim to the authenticated user with `/api/auth/convert-anonymous`.
7. If entitlement already active, website shows a return-to-app CTA immediately.
8. Otherwise website creates a Stripe Checkout Session.
9. Stripe webhook updates `entitlements`.
10. Success page tells the user to return to the app and offers `uttr://` deep link.
11. Desktop refreshes `/api/entitlement`.

No desktop web-auth session exchange is required in this version because entitlement lookup is install-token based.

## Audio Proxy Design

### Input contract

- Keep client-side WAV generation.
- Keep 16 kHz mono.
- Keep current client-side VAD-based reduction.

### Server handling

- Use Node runtime route handlers.
- Accept multipart requests up to `25 MB` initially.
- Do not persist audio to disk.
- Rebuild outbound multipart form and forward directly to Groq.
- Preserve `language` and `translate_to_english` fields.
- Return parsed transcript text plus timing metadata.

### Latency and cost changes

- Remove short-clip minimum-padding from the Uttr-managed cloud route.
- Trim trailing silence more aggressively before upload on the desktop path used for the proxy.
- Log:
  - client upload start
  - client upload end
  - backend receive time
  - backend forward start/end
  - Groq response time
  - backend response return time

## Security Requirements

### TDR-001 Server-held default provider credential

Only the backend may hold the Uttr-managed Groq key for the default cloud path.

### TDR-002 Install-scoped credentialing

Backend trial and entitlement routes must authenticate installs with a signed `install_token`, not with trust in raw client-provided IDs alone.

### TDR-003 Single-use claim handoff

Paywall claim tokens must be short-lived, hashed at rest, and single-use.

### TDR-004 Durable billing idempotency

Webhook-event processing must be persisted in Supabase and survive restarts and scale changes.

### TDR-005 Secure BYOK storage

User-provided Groq keys must be stored in Tauri Stronghold rather than plain app settings.

### TDR-006 Clear access resolution

The system must resolve access deterministically in the order `BYOK -> paid entitlement -> anonymous trial -> blocked`.

### TDR-007 Upload envelope enforcement

The backend must reject cloud uploads above the current supported cap before attempting proxy forwarding.

### TDR-008 Node runtime routes

Heavy backend routes must run on the Node runtime in the Fly deployment and not assume Edge-style limits.

## Rollout Plan

### Phase 1: hosting and durable data

- Move `marketing-site` to standalone Next.js output and Fly deployment.
- Add Supabase schema for trials, claims, entitlements, usage, and webhook events.
- Add durable webhook idempotency.

### Phase 2: anonymous trial and proxy

- Implement `/api/trial/bootstrap`.
- Implement `/api/transcribe/cloud`.
- Switch default desktop cloud path from direct Groq to proxy.

### Phase 3: onboarding and fallback

- Replace onboarding with immediate-use flow.
- Auto-download Parakeet V3.
- Ensure active-access-only local fallback.

### Phase 4: claim, auth, and checkout

- Implement claim-token creation.
- Implement authenticated anonymous-to-account linking.
- Wire landing-page sign-in plus checkout plus success flow.

### Phase 5: hidden BYOK

- Add hidden gesture.
- Add Stronghold-backed BYOK storage and validation.
- Route valid BYOK directly to Groq.

### Phase 6: latency cleanup

- Remove short-clip padding from proxy path.
- Tighten trailing-silence trimming.
- Measure end-to-end latency and adjust Fly sizing if needed.

## Failure Modes and Recovery

- Install token invalid or missing.
  - Recovery: force re-bootstrap and do not start a new trial automatically if the existing install row still exists.
- Claim token expired or already used.
  - Recovery: desktop requests a fresh claim token.
- Stripe webhook delivery delay.
  - Recovery: success page instructs the app to poll `/api/entitlement` with retry/backoff until entitlement turns active.
- Proxy route memory pressure.
  - Recovery: keep upload cap aligned with current Groq tier and size the Fly instance accordingly before raising limits.
- Fly deployment failure.
  - Recovery: one codebase rollback; no client secret exposure risk introduced.

## Verification and Test Strategy

### Backend verification

- `npm -C marketing-site run lint`
- route tests for:
  - bootstrap does not start trial
  - first proxy request starts trial
  - expired unpaid install is blocked
  - claim token is single-use and expires
  - webhook duplicate is ignored via durable storage
  - entitlement lookup resolves linked paid installs correctly

### Desktop verification

- `npm run lint`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- manual flows:
  - fresh install first transcription starts trial
  - trial active + cloud failure falls back to Parakeet if ready
  - expired unpaid blocks local-only use
  - hidden BYOK unlock + validation + direct Groq path

### End-to-end verification

- first-run install -> trial transcription
- expired install -> claim flow -> sign in -> checkout -> return to app
- existing subscriber on new install -> claim flow -> sign in -> no repurchase -> refresh access
- subscription cancellation reflected in future entitlement responses

## Source Links

- [Vercel Functions Limitations](https://vercel.com/docs/functions/limitations)
- [Next.js `output: "standalone"`](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)
- [Fly.io Next.js deployment guide](https://fly.io/docs/js/frameworks/nextjs/)
- [Groq Speech-to-Text docs](https://console.groq.com/docs/speech-to-text)
- [Stripe subscription Checkout](https://docs.stripe.com/payments/checkout/build-subscriptions)
- [Stripe customer portal](https://docs.stripe.com/customer-management)
- [Tauri Stronghold plugin](https://v2.tauri.app/plugin/stronghold/)

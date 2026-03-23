See `skills/shared/references/execution/task-management.md` for execution workflow and review guidelines.

# Anonymous Trial + Landing-Page Checkout + Backend-Proxy Cloud

## Scope Summary

- Move the existing `marketing-site` codebase from a Vercel-style site deployment to a Fly.io-hosted standalone Next.js app that can also serve as the backend proxy.
- Add Supabase-backed anonymous trial, claim-token, entitlement, usage, and durable webhook-event storage.
- Replace default direct Groq usage in the desktop app with a server proxy while keeping hidden BYOK available.
- Replace model/key-first onboarding with immediate usability plus background Parakeet V3 download.
- Route expired users to the landing page for sign-in and Stripe checkout, then unlock access by refreshing entitlement.

## Relevant Files

- `marketing-site/next.config.ts` - enable standalone output for serverful deployment.
- `marketing-site/package.json` - deployment/runtime scripts remain the entrypoint for the web/backend codebase.
- `marketing-site/README.md` - deployment/env documentation must reflect Fly + backend routes.
- `marketing-site/lib/env.ts` - centralize new backend env requirements.
- `marketing-site/lib/idempotency.ts` - replace in-memory webhook idempotency.
- `marketing-site/app/api/checkout/route.ts` - evolve into authenticated subscription checkout creation.
- `marketing-site/app/api/stripe/webhook/route.ts` - persist webhook events and entitlement updates.
- `marketing-site/app/**` - add landing-page claim, auth, success, and billing portal flows.
- `src-tauri/src/groq_client.rs` - keep only BYOK direct-Groq path.
- `src-tauri/src/managers/transcription.rs` - enforce access routing and local fallback rules.
- `src-tauri/src/settings.rs` - remove default-cloud Groq key dependency and add install/access state fields.
- `src-tauri/src/lib.rs` - register new Tauri commands and Stronghold plugin setup.
- `src/components/onboarding/Onboarding.tsx` - replace key/model-first onboarding with immediate-use flow.
- `src/components/settings/api-keys/ApiKeysSettings.tsx` - remove default visible Groq-key configuration.
- `src/components/settings/**` - add hidden BYOK unlock and settings UI.

## Task Ordering Notes

- Hosting and durable data must land before desktop routing switches to the proxy path.
- Durable webhook idempotency is required before entitlement enforcement can be trusted.
- Claim-token web flow should land before the desktop hard-block is exposed to users.
- Hidden BYOK can ship after the default proxy path; it is not a blocker for subscription rollout.
- Latency tuning belongs after the proxy path is functional and measured.

## Tasks

- [x] 1.0 Move `marketing-site` to a Fly-ready standalone backend deployment
  - covers_prd: `FR-003`, `FR-004`
  - covers_tdd: `TDR-008`
  - [x] 1.1 Enable standalone Next.js output and add Fly deployment assets
    - covers_prd: `FR-003`, `FR-004`
    - covers_tdd: `TDR-008`
    - output: `marketing-site/next.config.ts`, `marketing-site/Dockerfile`, `marketing-site/fly.toml`
    - verify: `npm -C marketing-site run build`
    - done_when: `marketing-site` builds into a standalone server image that can be deployed on Fly.io.
  - [x] 1.2 Document the new deployment and environment contract
    - covers_prd: `FR-003`, `FR-004`
    - covers_tdd: `TDR-008`
    - output: `marketing-site/README.md`, `marketing-site/lib/env.ts`
    - verify: `npm -C marketing-site run lint`
    - done_when: The README and env helpers describe Fly deployment plus every required backend secret and public URL.

- [x] 2.0 Add durable Supabase billing and access state
  - covers_prd: `FR-001`, `FR-006`, `FR-009`
  - covers_tdd: `TDR-002`, `TDR-003`, `TDR-004`
  - [x] 2.1 Create database schema for trials, claims, entitlements, usage, and webhook events
    - covers_prd: `FR-001`, `FR-006`, `FR-009`
    - covers_tdd: `TDR-002`, `TDR-003`, `TDR-004`
    - output: `marketing-site/supabase/migrations/*`
    - verify: `supabase db lint`
    - done_when: Supabase schema supports anonymous trial rows, claim tokens, entitlements, usage events, and durable webhook idempotency.
  - [x] 2.2 Replace process-local webhook idempotency with durable persistence
    - covers_prd: `FR-006`, `FR-009`
    - covers_tdd: `TDR-004`
    - output: `marketing-site/lib/idempotency.ts`, `marketing-site/app/api/stripe/webhook/route.ts`
    - verify: `npm -C marketing-site run lint`
    - done_when: Duplicate Stripe events are ignored using persisted event IDs rather than in-memory state.

- [x] 3.0 Build backend trial, entitlement, and proxy APIs
  - covers_prd: `FR-001`, `FR-002`, `FR-005`, `FR-006`, `FR-010`
  - covers_tdd: `TDR-001`, `TDR-002`, `TDR-003`, `TDR-006`, `TDR-007`, `TDR-008`
  - [x] 3.1 Implement bootstrap and entitlement routes for install-linked access
    - covers_prd: `FR-001`, `FR-006`
    - covers_tdd: `TDR-002`, `TDR-006`
    - output: `marketing-site/app/api/trial/bootstrap/route.ts`, `marketing-site/app/api/entitlement/route.ts`, `marketing-site/lib/access/*`
    - verify: `npm -C marketing-site run lint`
    - done_when: The backend can create or recover install-linked trial state, issue install tokens, and return access decisions without starting the trial early.
  - [x] 3.2 Implement the Groq proxy transcription route with upload enforcement and timing telemetry
    - covers_prd: `FR-002`, `FR-006`, `FR-010`
    - covers_tdd: `TDR-001`, `TDR-007`, `TDR-008`
    - output: `marketing-site/app/api/transcribe/cloud/route.ts`, `marketing-site/lib/groq/*`
    - verify: `npm -C marketing-site run lint`
    - done_when: The backend starts trials on first use, blocks expired unpaid installs, forwards valid uploads to Groq with the server-held key, and emits timing metadata.
  - [x] 3.3 Implement claim-token creation and anonymous-to-account linking
    - covers_prd: `FR-005`, `FR-006`
    - covers_tdd: `TDR-002`, `TDR-003`, `TDR-006`
    - output: `marketing-site/app/api/trial/create-claim/route.ts`, `marketing-site/app/api/auth/convert-anonymous/route.ts`
    - verify: `npm -C marketing-site run lint`
    - done_when: A blocked install can mint a short-lived claim token and the website can redeem it exactly once to link the install to the signed-in user.

- [x] 4.0 Finish website checkout and billing management for desktop-linked installs
  - covers_prd: `FR-005`, `FR-006`, `FR-009`
  - covers_tdd: `TDR-003`, `TDR-004`, `TDR-006`
  - [x] 4.1 Upgrade checkout creation to authenticated, install-aware subscription purchase
    - covers_prd: `FR-005`, `FR-006`
    - covers_tdd: `TDR-003`, `TDR-006`
    - output: `marketing-site/app/api/checkout/route.ts`, `marketing-site/app/(site)/**`, `marketing-site/lib/stripe.ts`
    - verify: `npm -C marketing-site run lint`
    - done_when: The site can sign users in, link the blocked install, and create a Stripe Checkout Session with enough metadata to update entitlements correctly.
  - [x] 4.2 Add success, claim, and billing-portal flows for returning users
    - covers_prd: `FR-005`, `FR-009`
    - covers_tdd: `TDR-004`, `TDR-006`
    - output: `marketing-site/app/**/page.tsx`, `marketing-site/app/api/billing/portal/route.ts`
    - verify: `npm -C marketing-site run lint`
    - done_when: Paid or already-entitled users can return from the site to the app, and existing subscribers can manage billing through Stripe’s customer portal.

- [x] 5.0 Replace desktop default cloud behavior with install-linked backend access
  - covers_prd: `FR-001`, `FR-002`, `FR-005`, `FR-006`, `FR-007`, `FR-010`
  - covers_tdd: `TDR-001`, `TDR-002`, `TDR-006`, `TDR-007`
  - [x] 5.1 Add install identity, trial state, access state, and entitlement refresh commands
    - covers_prd: `FR-001`, `FR-005`, `FR-006`
    - covers_tdd: `TDR-002`, `TDR-006`
    - output: `src-tauri/src/settings.rs`, `src-tauri/src/commands/**`, `src-tauri/src/lib.rs`, `src/bindings.ts`
    - verify: `cargo test --manifest-path src-tauri/Cargo.toml`
    - done_when: The desktop app can bootstrap install-linked access, cache trial/access state, request claim tokens, and refresh entitlement from the backend.
  - [x] 5.2 Replace default direct Groq transcription with the proxy path and preserve active-user fallback
    - covers_prd: `FR-002`, `FR-006`, `FR-010`
    - covers_tdd: `TDR-001`, `TDR-006`, `TDR-007`
    - output: `src-tauri/src/groq_client.rs`, `src-tauri/src/managers/transcription.rs`
    - verify: `cargo test --manifest-path src-tauri/Cargo.toml`
    - done_when: Default cloud transcription routes through the backend, expired unpaid installs are blocked, and local fallback runs only for active trial or paid users.
  - [x] 5.3 Replace onboarding with immediate-use flow and background Parakeet V3 download
    - covers_prd: `FR-007`
    - covers_tdd: `TDR-006`
    - output: `src/components/onboarding/Onboarding.tsx`, `src/stores/modelStore.ts`, `src/components/model-selector/**`
    - verify: `npm run lint`
    - done_when: New users are no longer asked for a Groq key or visible model choice during onboarding, and Parakeet V3 begins downloading automatically in the background.

- [ ] 6.0 Add hidden BYOK with secure storage
  - covers_prd: `FR-008`
  - covers_tdd: `TDR-005`, `TDR-006`
  - [ ] 6.1 Add Tauri Stronghold and migrate BYOK secret storage off plain settings
    - covers_prd: `FR-008`
    - covers_tdd: `TDR-005`
    - output: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `package.json`, `src-tauri/capabilities/**`
    - verify: `cargo test --manifest-path src-tauri/Cargo.toml`
    - done_when: The app has Stronghold configured and BYOK secrets are no longer stored in plain settings data.
  - [ ] 6.2 Add hidden unlock gesture, BYOK validation UI, and direct-Groq routing
    - covers_prd: `FR-008`
    - covers_tdd: `TDR-005`, `TDR-006`
    - output: `src/components/settings/**`, `src/hooks/useSettings.ts`, `src-tauri/src/groq_client.rs`
    - verify: `npm run lint`
    - done_when: BYOK stays hidden in normal UX, can be unlocked intentionally, validates correctly, and bypasses subscription gating only when valid.

- [ ] 7.0 Tighten proxy-path latency and regression coverage
  - covers_prd: `FR-010`
  - covers_tdd: `TDR-007`
  - [ ] 7.1 Remove short-clip padding on the proxy path and improve trailing-silence trimming
    - covers_prd: `FR-010`
    - covers_tdd: `TDR-007`
    - output: `src-tauri/src/managers/transcription.rs`, `src-tauri/src/audio_toolkit/**`, `marketing-site/app/api/transcribe/cloud/route.ts`
    - verify: `cargo test --manifest-path src-tauri/Cargo.toml`
    - done_when: Uttr-managed cloud uploads no longer add unnecessary minimum padding and trailing silence is trimmed more aggressively before proxy upload.
  - [ ] 7.2 Add focused verification for trial, billing, and proxy latency paths
    - covers_prd: `FR-005`, `FR-006`, `FR-009`, `FR-010`
    - covers_tdd: `TDR-004`, `TDR-007`
    - output: `marketing-site/**`, `src-tauri/**`
    - verify: `npm -C marketing-site run lint`, `npm run lint`, `cargo test --manifest-path src-tauri/Cargo.toml`
    - done_when: Automated and manual checks cover first-run trial, expired paywall, checkout unlock, durable webhook handling, and latency telemetry visibility.

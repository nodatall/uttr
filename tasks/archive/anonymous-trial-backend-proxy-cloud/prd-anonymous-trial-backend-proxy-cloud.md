# PRD: Anonymous Trial + Landing-Page Checkout + Backend-Proxy Cloud

## Plain-Language Summary

Uttr should feel usable immediately after install. People should be able to transcribe without creating an account first, the app should use Uttr-managed Groq cloud transcription by default, and the real Groq API key must stay on the server. New users get a 48 hour anonymous trial that starts on their first cloud transcription. When that trial ends, the desktop app blocks transcription and sends them to the existing landing page, where they can sign in or create an account and pay through Stripe. The landing page and backend stay in the existing `marketing-site` codebase, but the deployment moves off Vercel and onto a serverful host that can accept audio uploads for the proxy path.

## Product Goal

Ship a subscription-backed cloud transcription product without embedding any Uttr-owned Groq API key in the desktop app, while preserving a low-friction first-run experience and a local fallback for active users.

## Deployment Decision

- Keep one web/backend codebase: `marketing-site`.
- Stop treating Vercel as the target deployment for backend routes.
- Deploy `marketing-site` as a standalone Next.js server on Fly.io.
- Keep the public site, checkout, Stripe webhooks, and new desktop proxy routes in that same deployment.

## Target Users

- First-time desktop users who want to try Uttr immediately.
- Paying users who expect cloud transcription to work without managing their own provider key.
- Existing power users who still want hidden BYOK mode.
- Internal maintainers who need a single product surface for web billing plus backend enforcement.

## Problem Statement

Uttr currently calls Groq directly from the desktop app and stores Groq keys in client settings. That makes a bundled default Groq key impossible to protect. At the same time, requiring account creation or key setup before first use adds friction that conflicts with a trial-driven subscription product.

## Current-State Diagnosis

- The desktop app currently transcribes against Groq directly from `src-tauri/src/groq_client.rs`.
- Onboarding currently exposes Groq key entry and model selection in `src/components/onboarding/Onboarding.tsx`.
- Settings currently expose Groq API key management in `src/components/settings/api-keys/ApiKeysSettings.tsx`.
- The desktop app already uses a good cloud-audio format for Groq: WAV and 16 kHz mono.
- The desktop app already has a strong local fallback candidate: `parakeet-tdt-0.6b-v3`.
- `marketing-site` already supports Stripe Checkout and webhooks, but webhook idempotency is only in-memory and there is no entitlement enforcement yet.
- Vercel is not suitable for the audio proxy because its documented Function request-body limit is too small for this use case.

## Product Decisions

### Trial

- No account is required before first use.
- Trial duration is exactly 48 hours.
- Trial starts on first successful attempt to use Uttr-managed cloud transcription.
- Trial identity is tied to `install_id` and `device_fingerprint_hash`.
- Trial state survives relaunch and reinstall abuse is deterred server-side.

### Access Rules

- If BYOK is enabled and valid, transcription is allowed.
- Else if subscription entitlement is active, transcription is allowed.
- Else if anonymous trial is active, transcription is allowed.
- Else transcription is blocked.
- Users whose trial expired and who do not have BYOK or paid entitlement do not get free local-only usage.

### Cloud and Local Routing

- Uttr-managed Groq cloud is the default transcription path.
- Local Parakeet V3 downloads in the background during onboarding.
- While access is active, cloud stays first and local is fallback-only when cloud fails and the model is ready.
- Hidden BYOK mode uses the user’s own Groq key and may call Groq directly from the desktop app.

### Checkout and Billing

- The landing page is the monetization entrypoint.
- The desktop app does not embed signup, sign-in, or full billing UI.
- After trial expiry the app opens the landing page with a server-issued claim token.
- The landing page handles sign-in or account creation and then either:
  - starts Stripe Checkout for unpaid users, or
  - returns the user to the app if entitlement is already active.
- Stripe remains the source of truth for billing status.

### Hosting

- The same `marketing-site` codebase becomes the backend proxy and entitlement service.
- The deployment target is Fly.io, not Vercel.
- The app is deployed as a standalone Next.js Node server, not Edge functions.

## User Stories

- As a new user, I can install Uttr and transcribe immediately without creating an account first.
- As a new user, my free trial starts only when I actually use cloud transcription.
- As a paying user, I can subscribe on the website and return to the desktop app with access unlocked.
- As a user with an active subscription, I still get local fallback if the cloud path fails.
- As a power user, I can unlock BYOK and use my own Groq key without subscribing.

## Functional Requirements (`FR-*`)

### FR-001 Desktop-first anonymous trial

The app must support a 48 hour anonymous trial that begins on first successful Uttr-managed cloud transcription rather than on install or first launch.

### FR-002 Server-held Groq credential

Default cloud transcription must go through an Uttr-controlled backend proxy so no Uttr-owned Groq key is embedded in the desktop app.

### FR-003 Single web/backend codebase

The existing `marketing-site` codebase must become the product website, checkout surface, Stripe webhook receiver, entitlement service, and cloud transcription proxy.

### FR-004 Serverful deployment

The backend-capable `marketing-site` deployment must run on Fly.io as a standalone Next.js server so the proxy can accept audio uploads larger than Vercel’s function cap.

### FR-005 Paywall and claim handoff

When a user without active access attempts transcription after trial expiry, the desktop app must block transcription, request a claim token, and open the landing page with enough context to complete purchase and attach that install to a user account.

### FR-006 Subscription entitlement enforcement

The backend must persist subscription state and return a clear access decision for the desktop app based on anonymous trial, paid entitlement, or BYOK bypass.

### FR-007 Background local readiness

The app must automatically begin downloading Parakeet V3 during onboarding or initial setup without making local-model choice a required first-run step.

### FR-008 Hidden BYOK

BYOK must stay available but hidden from normal onboarding and default settings UX, and valid BYOK must bypass trial/subscription blocking.

### FR-009 Durable billing correctness

Stripe webhook processing and entitlement updates must be durable across restarts and deploys; in-memory webhook idempotency is not sufficient for this feature.

### FR-010 Latency-preserving proxy path

The default cloud path must preserve the current WAV and 16 kHz mono behavior, remove unnecessary short-clip padding on the proxy path, aggressively trim trailing silence before upload, and emit enough timing telemetry to measure proxy overhead separately.

## Explicit Non-Goals

- Building a separate microservice outside `marketing-site`.
- Supporting free local-only usage after anonymous trial expiry.
- Exposing BYOK in normal onboarding or the default settings path.
- Supporting multiple local models in the normal first-run UX.
- Redesigning the landing page brand or pricing model as part of this work.
- Implementing multi-provider cloud routing beyond Groq in this plan.

## Product Rules

- Default cloud access never depends on a client-side Uttr Groq key.
- The desktop app is the runtime client, not the billing portal.
- The landing page is the place for account creation, sign-in, checkout, and subscription management.
- Paid and trial users may use local fallback when cloud fails.
- Expired unpaid users may not transcribe, even if Parakeet is already downloaded.
- Initial proxy uploads are capped to the Groq free-tier file ceiling so the app and server enforce the same operational contract.

## Success Criteria

- A fresh install can transcribe without account creation or BYOK.
- Trial starts on first cloud transcription and lasts 48 hours from that timestamp.
- No Uttr-managed Groq key is required in client settings for default cloud use.
- Expired users are redirected to the landing page and can complete sign-in plus Stripe checkout successfully.
- Stripe webhook updates unlock or revoke entitlement correctly after restart-safe processing.
- Active users fall back to local transcription when cloud fails and Parakeet is ready.
- Hidden BYOK remains functional and bypasses subscription gating when valid.
- Proxy latency is measured and does not materially degrade expected UX beyond the network hop itself.

## Acceptance Criteria

- AC-001 (`FR-001`): A fresh install that has never transcribed can bootstrap anonymous access without creating an account.
- AC-002 (`FR-001`): Trial state changes from `new` to `trialing` only when the first Uttr-managed cloud transcription request is accepted.
- AC-003 (`FR-001`, `FR-006`): Trial status survives relaunch and is enforced consistently on future requests from the same install.
- AC-004 (`FR-002`): Default Groq transcription succeeds without any Uttr-owned API key being present in desktop settings or binary resources.
- AC-005 (`FR-003`, `FR-004`): The existing `marketing-site` codebase can serve the landing page, billing endpoints, and proxy endpoints from one Fly.io deployment.
- AC-006 (`FR-005`): An expired install attempting transcription receives a blocked response, creates a claim token, opens the landing page, and can resume access after checkout.
- AC-007 (`FR-006`, `FR-009`): Stripe webhook processing persists entitlement changes durably and does not rely on process-local memory for idempotency.
- AC-008 (`FR-007`): Onboarding no longer requires visible Groq key entry or visible model selection, and Parakeet V3 starts downloading in the background.
- AC-009 (`FR-008`): BYOK is absent from normal onboarding/settings, can be unlocked through a hidden gesture, and bypasses subscription gating only when validation succeeds.
- AC-010 (`FR-010`): The proxy path keeps WAV + 16 kHz mono uploads, logs timing breakdowns, and removes short-clip padding from the server-routed cloud path.

## Constraints and Defaults

- Hosting default is Fly.io using a standalone Next.js deployment from `marketing-site`.
- Initial deployment should run as a single-region US service and stay simple until latency data justifies a more complex topology.
- Supabase remains the app database and account system for the website.
- Stripe remains the billing provider.
- Groq remains the default cloud transcription provider.
- Parakeet V3 remains the only local model surfaced in normal UX.
- Hidden BYOK remains the only user-managed cloud-key path.

## Risks and Guardrails

- The proxy introduces a new network hop.
  - Guardrail: keep request handling thin and log latency stages end-to-end.
- Billing state becomes product-critical.
  - Guardrail: store processed webhook events and entitlement rows durably in Supabase.
- Moving onboarding from model-choice-first to usable-immediately can create UX regressions.
  - Guardrail: keep onboarding narrow and make background model download status visible but non-blocking.
- Install-linked access can become confusing if account linkage is not deterministic.
  - Guardrail: claim tokens must be short-lived, single-use, and generated only from the blocked install.

## Source Links

- [Vercel Functions Limitations](https://vercel.com/docs/functions/limitations)
- [Next.js `output: "standalone"`](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)
- [Fly.io Next.js deployment guide](https://fly.io/docs/js/frameworks/nextjs/)
- [Groq Speech-to-Text docs](https://console.groq.com/docs/speech-to-text)
- [Stripe subscription Checkout](https://docs.stripe.com/payments/checkout/build-subscriptions)
- [Stripe customer portal](https://docs.stripe.com/customer-management)
- [Tauri Stronghold plugin](https://v2.tauri.app/plugin/stronghold/)

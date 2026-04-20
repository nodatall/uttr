# Production Readiness Repo Sweep

Date: 2026-04-20
Scope: Uttr production user paths for download, install/open, trial, upgrade, account, Stripe Checkout, webhooks, entitlement persistence, app activation, billing portal/cancel/retry, expired trial, failed checkout, duplicate checkout, signed-out checkout, token mismatch, webhook delays, and production env/config failures.

## Audit Thesis

Uttr's launch risk is concentrated at boundaries between independently correct systems: the installed desktop app issues and refreshes install/account state, the marketing site owns account and checkout flows, Stripe completes payment asynchronously, Supabase persists entitlement state, and the desktop app must recover access after webhook or browser delays.

The current branch is materially stronger than the earlier billing sweep baseline. Runtime/API probes and tests show the unauthenticated paths fail closed, naked `/claim` routes to app download, signed-out checkout is blocked, webhooks require Stripe signatures, entitlement and portal APIs require the expected tokens, and browser-visible account/download pages render in production mode.

Two production-blocking or near-blocking issues remain before launch: the deploy artifact can fail from a clean checkout because the Dockerfile requires an ignored lockfile, and the `redeem_trial_claim` `SECURITY DEFINER` RPC lacks the explicit execution restrictions now used by newer service-role-only RPCs.

## Security

1. `redeem_trial_claim` is a `SECURITY DEFINER` RPC with no explicit `REVOKE`/`GRANT` restriction.

   Evidence: `marketing-site/supabase/migrations/20260323134000_redeem_trial_claim_rpc.sql` defines `public.redeem_trial_claim(p_claim_token_hash text, p_user_id uuid)` as `security definer`, updates `trial_claims.redeemed_at`, and binds `anonymous_trials.user_id = p_user_id`. `rg` found no corresponding grant restriction for this function, while newer service-only RPCs in `20260419093000_rate_limits.sql` and `20260419100000_webhook_event_processing.sql` explicitly revoke execution from `public`, `anon`, and `authenticated` before granting `service_role`.

   Impact: if Supabase exposes default function execution to API roles in the deployed database, a caller with a claim-token hash could bypass the Next route's session check and bind a claim to a supplied user id. The intended path appears to be server-side only through `marketing-site/lib/access/supabase.ts`.

2. Hostile-origin probes did not show permissive CORS.

   Evidence: hostile `Origin` `POST /api/checkout` returned `401` with no `Access-Control-Allow-Origin`; hostile `OPTIONS /api/checkout` returned `204` with `Allow: OPTIONS, POST` but no permissive origin or credentials header.

3. Query-token leakage appears fixed for the inspected request helpers.

   Evidence: `GET /api/entitlement?install_token=leaky-token` returned `400 Missing install token`; `readInstallTokenFromRequest` reads bearer/custom headers, not query parameters.

## Architecture and Design

1. The production user path now follows the intended download-first, install-linked purchase model.

   Evidence: production-mode `/claim` without a token rendered "Download Uttr first" and the GitHub release download link. `/claim?claim_token=probe-token&source=desktop` rendered an account form instead of jumping directly to Stripe.

2. Checkout is gated by both Supabase session and claim context for non-entitled users.

   Evidence: `POST /api/checkout {}` returned `401 Missing Supabase access token`; the route code requires a Supabase bearer/cookie token and blocks checkout when an install-linked claim context is absent.

3. Account and billing portal routes fail closed when signed out.

   Evidence: `/account` rendered a sign-in form on mobile; `POST /api/billing/portal {}` returned `401 Missing Supabase access token`.

## Logic and Stability

1. Clean deployment is at risk because the Dockerfile requires `package-lock.json`, but the lockfile is ignored and not tracked.

   Evidence: `marketing-site/Dockerfile` copies `package.json package-lock.json` and runs `npm ci`. `.gitignore` ignores all `package-lock.json` files. `git ls-files marketing-site/package-lock.json` returned no tracked file, even though the local ignored file exists.

   Impact: local `npm run build` can pass, but Fly/GitHub/clean Docker builds can fail at the dependency stage. This is a launch blocker for a reproducible production deployment.

2. Webhook critical persistence happens before completion bookkeeping and duplicate handling appears durable in code/tests.

   Evidence: webhook route verifies `stripe-signature`, uses `beginWebhookEvent`, performs persistence before `completeWebhookEvent`, and treats post-commit email as a side effect. Existing tests cover concurrent in-progress, duplicate, and failure-state behavior.

3. Expired trial, failed checkout, duplicate checkout, webhook delay, cancellation/retry, and payment completion were not live-tested against Stripe/Supabase.

   Evidence: local Supabase could not start because Docker was unavailable, and no live Stripe account/API credentials were used for this sweep. These paths are covered by code inspection and tests, not an end-to-end live transaction.

## Testing and Verification

Commands run:

- `bun test` in `marketing-site`: 67 passing tests.
- `npm run lint` in `marketing-site`: passed.
- `npm run build` in `marketing-site`: passed.
- `bun run lint` at repo root: passed.
- `bun run build` at repo root: passed, with Vite's existing large chunk warning.
- `bun run check:translations` at repo root: passed.
- `cargo test access --quiet` in `src-tauri`: 5 tests passed, with filtered-target dead-code warnings.

Runtime/API probes:

- `/api/checkout` without auth: `401 Missing Supabase access token`.
- `/api/trial/create-claim` without install token: `400 Missing install token`.
- `/api/trial/create-claim` with malformed install token: `401 Invalid install token signature`.
- `/api/entitlement` without install token: `400 Missing install token`.
- `/api/billing/portal` without auth: `401 Missing Supabase access token`.
- `/api/stripe/webhook` without Stripe signature: `400 Missing stripe-signature header`.
- `/api/auth/convert-anonymous` without auth: `401 Missing Supabase access token`.
- `/api/transcribe/cloud` without install token: `400 Missing install token`.
- `/api/trial/bootstrap` reached the Supabase dependency and returned `500` because local Supabase was down.

Browser artifacts preserved:

- `tasks/tmp/repo-sweep-production-readiness-2026-04-20/page-2026-04-20T04-55-56-956Z.yml`
- `tasks/tmp/repo-sweep-production-readiness-2026-04-20/page-2026-04-20T04-56-11-228Z.yml`
- `tasks/tmp/repo-sweep-production-readiness-2026-04-20/page-2026-04-20T04-56-26-720Z.yml`
- `tasks/tmp/repo-sweep-production-readiness-2026-04-20/console-2026-04-20T04-56-10-873Z.log`

## Code Quality and Maintainability

1. Stripe SDK API version is pinned behind the current best-practice reference.

   Evidence: `marketing-site/lib/stripe.ts` pins `apiVersion: "2026-01-28.clover"`. The loaded Stripe best-practices reference names `2026-02-25.clover` as current. This is not the same severity as the Docker/RPC issues, but it should be intentionally accepted or updated before launch.

2. Marketing-site README text is partly stale around webhook idempotency and entitlement enforcement.

   Evidence: README text still describes in-memory webhook idempotency for the deployment unit, while current code uses durable webhook event state. Stale operational docs can mislead incident response or launch validation.

## Performance and Operations

1. Docker-based deployment could not be validated locally because Docker was unavailable.

   Evidence: `supabase status` failed with `Cannot connect to the Docker daemon at unix:///Users/fromdarkness/.docker/run/docker.sock`; the same host limitation prevented local clean Docker/Fly reproduction. Source evidence is still enough to flag the untracked lockfile as a deploy risk.

2. Required production env is fail-closed in code.

   Evidence: `marketing-site/lib/env.ts` centralizes required `NEXT_PUBLIC_SITE_URL`, Stripe, Supabase, Groq, install-token secret, and claim-token secret variables. Missing env should fail at server use rather than silently degrading into mock billing.

## Needs Human Decision

1. Decide whether the deploy package manager should be npm with a tracked `marketing-site/package-lock.json`, or whether the Dockerfile/deployment should switch to the repo's Bun workflow.

2. Decide whether `redeem_trial_claim` should be service-role-only, or whether there is an intentional direct client RPC use that must be preserved with stricter argument/session validation.

3. Decide whether to update Stripe API version now or defer with a documented reason.

## Residual Risks

- No signed release download, install, first open, notarization/Gatekeeper, or real app activation smoke was completed in this sweep.
- No live Stripe Checkout payment, cancellation, billing portal retry, failed card, duplicate browser checkout, or webhook redelivery was executed.
- No live Supabase migration/grant state was inspected; the RPC finding is source-backed and must be confirmed against deployed grants.
- Local Supabase was down, so trial bootstrap, entitlement persistence, and webhook-to-desktop refresh were not DB-backed end-to-end.
- Webhook delay behavior was verified by code/tests, not by waiting for real delayed Stripe delivery.
- Production env values were checked structurally and redacted locally, not proven in the deployed Fly environment.

## Fix Recommendation

Fix the Docker lockfile/deployment mismatch first because it can block deployment outright. Then restrict `redeem_trial_claim` execution to the intended server role and add a migration/test that asserts the grant contract. After those, decide the Stripe API version and stale README cleanup, then run a live staging transaction with Stripe CLI or a real test-mode Checkout flow against a working Supabase instance.

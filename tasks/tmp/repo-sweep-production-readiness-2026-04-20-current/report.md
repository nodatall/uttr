# Repo Sweep Production Readiness Report

Date: 2026-04-20
Mode: `$repo-sweep --preserve-review-artifacts`
Scope: download, install/open, trial, Pro upgrade, account auth, Stripe Checkout, webhooks, entitlement persistence, billing portal, cancellation/retry, failure paths, token mismatch, webhook delay, and production config.

## Audit Thesis

The main production risk is state convergence across the desktop install token, website account session, checkout-session ledger, Stripe event stream, and local app entitlement snapshot. The happy path now works locally, but retry and webhook-delay paths still have failure modes where a real user can pay or attempt to retry and remain blocked.

## Runtime Probes

- Local server: existing Next server on `http://localhost:4317`.
- Browser evidence captured with Playwright CLI:
  - `output/playwright/uttr-sweep-home-2026-04-20.png`
  - `output/playwright/uttr-sweep-claim-no-token-2026-04-20.png`
  - `output/playwright/uttr-sweep-claim-token-2026-04-20.png`
  - `output/playwright/uttr-sweep-account-signed-out-2026-04-20.png`
  - `output/playwright/uttr-sweep-cancel-2026-04-20.png`
  - `output/playwright/uttr-sweep-success-active-2026-04-20.png`
  - `output/playwright/uttr-sweep-legal-2026-04-20.png`
  - `output/playwright/uttr-sweep-claim-mobile-2026-04-20.png`
- Verified claim-to-checkout path with local Postgres and Stripe test key:
  - bootstrap install: `200`, `trial_state=new`, `access_state=blocked`
  - create claim: `200`
  - signup: `200`
  - convert anonymous install: `200`, `status=linked`, `checkout_safe=true`
  - checkout first request: `200`, `checkout.stripe.com`
  - checkout duplicate request: `200`, same checkout URL reused
- Verified expired trial: local trial forced past `trial_ends_at`; `/api/entitlement` returned `trial_state=expired`, `access_state=blocked`, `entitlement_state=inactive`.
- Verified signed-out failure paths:
  - `/api/checkout`: `401 Missing session`
  - `/api/billing/portal`: `401 Missing session`
  - `/api/trial/create-claim`: `400 Missing install token`
  - `/api/entitlement`: `400 Missing install token`
  - `/api/stripe/webhook`: `400 Missing stripe-signature header`
- Verified app/site token mismatch: signed-but-nonexistent install token returns `401 Invalid install token`.
- Verified Stripe webhook idempotency for a signed no-op event: first delivery `200`, replay `200 duplicate=true`.
- Verified webhook malformed completion behavior: signed `checkout.session.completed` event without subscription/customer returned `200 received=true`.
- Verified bootstrap rate limit in dev mode: 30 invalid requests returned `400`, request 31 returned `429`.
- Verified signin lacks equivalent rate limit: 10 invalid sign-in attempts returned `401`.
- Verified hostile-origin probes did not emit `Access-Control-Allow-Origin`.

## Validation

- `bun test` in `marketing-site`: pass, 71 tests.
- `npm --prefix marketing-site run lint`: pass.
- `npm --prefix marketing-site run build`: pass.
- `npm run lint`: pass.
- `npm run build`: pass, with Vite chunk-size warning.
- `npm run check:translations`: pass.
- `cargo test` in `src-tauri`: fail, 149 passed, 1 failed, 1 ignored. Failing test: `audio_toolkit::audio::import::tests::rejects_unsupported_extensions`.
- Root `npm test` was not run because the root `package.json` does not define a `test` script.

## Findings

1. Expired open checkout rows can block checkout retry if Stripe's `checkout.session.expired` webhook is delayed or missing. Code ignores expired `status='open'` rows as reusable, but the partial unique index still blocks inserting the next open row until status changes to `expired`.
2. A malformed or incomplete `checkout.session.completed` webhook can be acknowledged and marked processed without persisting entitlement. The route logs missing user/subscription/customer and still completes the webhook event, suppressing Stripe retry.
3. Account sign-in/sign-up endpoints have no route-level rate limit. Runtime probe confirmed repeated invalid sign-in attempts return `401`, while bootstrap rate limiting returns `429` after the configured threshold.
4. Full Rust validation is currently red because an unsupported-extension audio import test expects an error string that no longer matches the actual failure.
5. The local/prod app activation path after payment is only indirectly verified. The app refreshes entitlement on focus/visibility and startup, but no hosted Checkout completion was driven end-to-end to confirm that a real paid Stripe session updates the app snapshot without manual user intervention.

## Residual Risk

- Real hosted Stripe payment completion was not completed in the browser; the sweep verified Checkout session creation/reuse and signed webhook mechanics, not an actual card payment round trip.
- Billing portal with a real subscribed customer was not opened because the local probe did not complete a paid subscription.
- Production deploy health for missing env vars was statically inspected but not tested against a production-like container with secrets removed.
- macOS packaged install/open/notarization was not executed in this sweep; desktop validation here was code/test based.

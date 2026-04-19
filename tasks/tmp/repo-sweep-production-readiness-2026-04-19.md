# Repo Sweep: Production Readiness

Date: 2026-04-19
Scope: real user paths for download/install/open, trial, upgrade, account login, Stripe Checkout, webhook completion, entitlement persistence, activation, billing portal, cancel/retry, failed and duplicate checkout, signed-out checkout, token mismatch, webhook delays, and production env/config failures.

## Audit Thesis

Uttr's strongest production-readiness risk is recovery-path drift, not the happy path. The install-linked first-purchase model is mostly coherent, but once an install is linked to an account and the subscription is no longer active, the desktop app falls back to first-purchase claim-token behavior that cannot succeed for linked installs. Billing recovery and duplicate-checkout protection need to be made explicit before production.

## Findings

1. Linked non-active subscribers can be blocked from billing recovery.
   - Evidence: `src/components/settings/UpgradeButton.tsx` shows the upgrade path for every non-subscribed access state and creates a trial claim token; `src/components/settings/ManageSubscriptionButton.tsx` hides billing portal unless `access_state === "subscribed"`; `marketing-site/app/api/trial/create-claim/route.ts` rejects linked installs with 409; Stripe webhook maps `past_due`, `canceled`, and inactive states into non-active entitlement states.
   - Impact: failed payment retry, cancellation/reactivation, expired trial after account link, and app activation recovery can send the user into a claim flow that cannot produce a valid checkout.

2. Checkout creation has duplicate-session and webhook-delay risk.
   - Evidence: `marketing-site/app/(site)/claim/claim-flow.tsx` ignores convert-anonymous 409 and proceeds to checkout; `marketing-site/app/api/checkout/route.ts` checks only current DB entitlement state, creates a new Checkout Session each call, uses `customer_email` instead of a saved Stripe Customer, and has no persisted in-flight checkout guard or idempotency key.
   - Impact: repeated clicks, retries, or delayed webhooks can create multiple Checkout Sessions and potentially multiple subscriptions for the same install/account.

3. Production abuse limits are process-local and header-spoofable.
   - Evidence: `marketing-site/lib/rate-limit.ts` uses an in-memory `Map` and trusts `x-forwarded-for` / `x-real-ip`; public endpoints such as trial bootstrap, claim creation, and cloud transcription depend on this helper.
   - Impact: limits reset across deploys/instances and may be bypassed if proxy headers are not normalized before the app.

4. Production dependency audit fails.
   - Evidence: `npm audit --omit=dev --audit-level=moderate` in `marketing-site` reports high-severity Next advisories for the current `next` version; root `bun audit --audit-level moderate` reports high/moderate issues including direct/transitive build-chain packages.
   - Impact: the marketing site is a public production surface and should not ship with known high-severity framework advisories.

5. Validation surface is not currently clean.
   - Evidence: `cargo test --quiet` fails `audio_toolkit::audio::import::tests::rejects_unsupported_extensions`; `bun run format:check` fails broadly because Prettier scans generated and cache directories such as `.playwright-cli` and `marketing-site/.next`.
   - Impact: release confidence is reduced because full local verification cannot pass without filtering noise and fixing the broken regression test.

## Verified During Sweep

- Hostile-origin API probes against local server on port 4317 failed closed without CORS allow-origin headers for checkout, billing portal, claim creation, cloud transcription, webhook, bootstrap, and entitlement routes.
- `/claim` without a token renders a download-first path with no checkout controls.
- `/account` renders account login and download-first messaging.
- Root lint, root build, translation checks, marketing lint, marketing build, marketing `bun test`, and targeted Rust access tests passed.
- Root and marketing `npm test --if-present` found no actual test script.
- No committed secrets were found by targeted secret scans; `.env.local` is ignored.

## Commands Run

- `npm test --if-present`
- `bun run lint`
- `bun run build`
- `bun run check:translations`
- `bun run format:check`
- `cargo test access --quiet`
- `cargo test --quiet`
- `npm test --if-present` in `marketing-site`
- `bun test` in `marketing-site`
- `npm run lint` in `marketing-site`
- `npm run build` in `marketing-site`
- `npm audit --omit=dev --audit-level=moderate` in `marketing-site`
- `bun audit --audit-level moderate`
- Browser screenshots for `/claim` and `/account`
- API probes for checkout, billing portal, claim, bootstrap, cloud transcription, webhook, and entitlement

## Residual Risk

- I did not run a signed/notarized DMG install/open path.
- I did not execute real Stripe Checkout, live webhook replay, Customer Portal cancel/retry, or live Supabase entitlement writes.
- I did not verify production proxy behavior, deployed env vars, Stripe dashboard portal settings, Apple signing identity availability, or notarization output.
- App/site token mismatch and delayed-webhook convergence were assessed from code paths and invalid probes, not from an end-to-end live account.

## Recommended Fix Order

1. Fix linked non-active billing recovery and duplicate Checkout/idempotency first.
2. Upgrade audited production dependencies and move public rate limiting to a durable trusted-proxy-aware store.
3. Restore full validation by fixing the Rust test and narrowing Prettier ignores.
4. Run a live Stripe/Supabase sandbox pass and signed app install/open smoke after the code fixes.

# Sub-task 5.1 Contract

## goal

Run final validation and local probes for the billing recovery hardening work, then record residual production-path risk that cannot be safely exercised locally.

## in_scope

- Run marketing-site unit/API tests, lint, and production build.
- Run desktop app lint/build/translation validation for touched billing UI surfaces.
- Run focused API-path tests for checkout dedupe, claim conversion client gating, webhook pending-checkout lifecycle, and production rate-limit responses.
- Run a local browser render probe for the claim/account entry point.
- Record live-path gaps that require staging or production Stripe/Supabase credentials and signed desktop install packaging.

## out_of_scope

- Creating live Stripe Checkout Sessions.
- Sending live webhook events to production.
- Running signed macOS packaging/notarization.
- Mutating production Supabase data.

## surfaces

- `marketing-site/app/api/checkout/route.ts`
- `marketing-site/app/api/stripe/webhook/route.ts`
- `marketing-site/lib/idempotency.ts`
- `marketing-site/app/(site)/claim/claim-flow.tsx`
- `marketing-site/app/api/trial/create-claim/route.ts`
- `marketing-site/lib/checkout.ts`
- `marketing-site/lib/rate-limit.ts`
- `src/components/settings/UpgradeButton.tsx`
- `src/components/settings/ManageSubscriptionButton.tsx`
- `src/lib/utils/premiumFeatures.ts`

## acceptance_checks

- All changed automated checks pass.
- Focused API tests exercise duplicate checkout reuse, webhook completion/expiration, typed claim gating, and rate-limit unavailable/exhausted paths.
- Browser probe confirms the claim page renders the account form at desktop claim URL and mobile viewport without console warnings.
- Residual risks explicitly call out unexercised live Stripe/Supabase, signed installer/open, and desktop token mismatch paths.

## reference_patterns

- Repo-local scripts in root `package.json` and `marketing-site/package.json`.
- Existing Bun route/helper tests.
- Playwright CLI skill for browser probe.

## test_first_plan

No implementation code is expected in this slice. This is a verification/finalization task, so the red/green loop is not applicable.

## verify

- `cd marketing-site && bun test`
- `cd marketing-site && npm run lint`
- `cd marketing-site && npm run build`
- `bun run lint`
- `bun run build`
- `bun run check:translations`
- focused API tests for checkout, claim conversion client, create-claim rate limiting, and webhook lifecycle
- local browser probe of `/claim?claim_token=probe-token&source=desktop`

## verification_result

- `cd marketing-site && bun test` passed: 65 tests after final review fixes.
- `cd marketing-site && npm run lint` passed.
- `cd marketing-site && npm run build` passed.
- `bun run lint` passed.
- `bun run build` passed with the existing Vite large-chunk warning.
- `bun run check:translations` passed for all 16 non-English locales.
- Focused API tests passed: `lib/checkout.test.ts`, `lib/access/claim-conversion-client.test.ts`, `app/api/trial/create-claim/route.test.ts`, and `app/api/stripe/webhook/route.test.ts`.
- Local browser probe passed against `http://127.0.0.1:3211/claim?claim_token=probe-token&source=desktop`: desktop snapshot rendered account controls; mobile 390x844 screenshot rendered the same controls; console warning scan returned no warnings.
- Final full-branch review found and fixes addressed two concurrency risks: webhook idempotency now records durable completion only after side effects succeed and marks failed/in-progress work retryable; checkout persistence failure no longer expires a deterministic Stripe session that another concurrent request may already have returned.

## residual_risk

- Live Stripe Checkout redirect, hosted Customer Portal cancellation/retry, and Stripe webhook delivery timing were verified through mocked route/helper tests only; safe live probes need staging Stripe/Supabase resources.
- Signed desktop download/install/open and app activation were not run in this web/billing slice.
- App/site token mismatch and webhook-delay recovery were covered through typed claim/client and pending-session tests, not with a real installed desktop app against a deployed site.

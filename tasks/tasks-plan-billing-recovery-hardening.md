See `skills/shared/references/execution/task-management.md` for execution workflow and review guidelines.

# Billing Recovery Hardening

## Scope Summary

- Fix four production-readiness findings: dead linked non-active upgrade path, duplicate checkout session creation, ambiguous claim conversion 409 handling, and non-durable production rate limiting.
- Highest-risk areas are Stripe/Supabase state boundaries, first-purchase install-origin gating, and recovery behavior under webhook delay.

## Relevant Files

- `src/components/settings/UpgradeButton.tsx` - Desktop upgrade entry point currently creating claim tokens for every non-subscribed state.
- `src/components/settings/ManageSubscriptionButton.tsx` - Desktop account/billing management entry point currently hidden unless subscribed.
- `src/lib/utils/premiumFeatures.ts` - Existing access-state helper pattern for billing UI logic.
- `marketing-site/app/(site)/claim/claim-flow.tsx` - Browser claim/auth/checkout flow.
- `marketing-site/app/api/auth/convert-anonymous/route.ts` - Claim conversion endpoint.
- `marketing-site/app/api/trial/create-claim/route.ts` - Install-origin token creation endpoint.
- `marketing-site/app/api/checkout/route.ts` - Stripe Checkout creation endpoint.
- `marketing-site/app/api/stripe/webhook/route.ts` - Subscription and checkout webhook persistence.
- `marketing-site/lib/access/supabase.ts` - Supabase REST persistence helpers.
- `marketing-site/lib/access/types.ts` - Access, entitlement, and persistence row types.
- `marketing-site/lib/rate-limit.ts` - Existing in-memory rate-limit helper.
- `marketing-site/supabase/migrations/` - Schema migrations for access/billing persistence.
- `marketing-site/lib/*.test.ts` and `marketing-site/lib/access/*.test.ts` - Existing Bun unit test style.

## Task Ordering Notes

- Land persistence/schema before route code depends on it.
- Keep first-purchase checkout install-origin gated. Do not introduce naked web checkout as a shortcut for linked recovery.
- Desktop billing action matrix:
  - subscribed/active: show account management only.
  - `past_due`: show account/payment update only; do not create first-purchase checkout.
  - `canceled` or entitlement `expired`: show reactivation checkout tied to install and existing account/customer when available.
  - entitlement `inactive` with linked trial: show app-origin checkout retry/reactivation.
  - unlinked `new`, `trialing`, or expired trial: keep app-origin claim checkout.
- Use failing targeted tests first where practical for route/helper behavior.
- Broader dependency-audit and format-check cleanup are out of scope unless they block the focused verification commands.

## Tasks

- [x] 1.0 Make billing state decisions explicit
  - covers_prd: `FR-002`, `FR-007`
  - covers_tdd: `TDR-001`, `TDR-002`
  - [x] 1.1 Add shared desktop billing action logic and update billing buttons so linked non-active states have one actionable path instead of conflicting or dead actions.
    - covers_prd: `FR-002`, `FR-007`
    - covers_tdd: `TDR-001`, `TDR-002`
    - output: `src/components/settings/UpgradeButton.tsx`, `src/components/settings/ManageSubscriptionButton.tsx`, likely a small shared helper under `src/lib/utils/`
    - verify: focused frontend logic test if repo pattern exists, otherwise `bun run lint`
    - done_when: `past_due` shows account/payment update without calling `createTrialClaim()`, `canceled`/entitlement `expired` shows reactivation checkout, linked inactive shows app-origin checkout retry, subscribed shows account management, and first-purchase unlinked states still can start app-origin checkout.

- [x] 2.0 Persist and reuse checkout attempts
  - covers_prd: `FR-001`, `FR-003`, `FR-005`
  - covers_tdd: `TDR-003`, `TDR-004`, `TDR-005`, `TDR-006`, `TDR-011`
  - [x] 2.1 Add Supabase schema and helper functions for pending checkout sessions.
    - covers_prd: `FR-003`
    - covers_tdd: `TDR-003`, `TDR-006`, `TDR-011`
    - output: `marketing-site/supabase/migrations/`, `marketing-site/lib/access/types.ts`, `marketing-site/lib/access/supabase.ts`, focused tests
    - verify: `cd marketing-site && bun test`
    - done_when: helpers can find reusable open sessions, insert new pending sessions, enforce one open pending checkout per user/install context, and mark sessions completed/expired with mocked Supabase REST evidence.
  - [x] 2.2 Harden `/api/checkout` to reuse pending sessions, reuse Stripe customers, and create sessions with deterministic idempotency keys.
    - covers_prd: `FR-001`, `FR-003`, `FR-005`
    - covers_tdd: `TDR-003`, `TDR-004`, `TDR-005`, `TDR-010`, `TDR-011`
    - output: `marketing-site/app/api/checkout/route.ts`, `marketing-site/lib/stripe.ts` or route-local helpers, focused tests
    - verify: `cd marketing-site && bun test`
    - done_when: repeated checkout requests for the same user/install return the existing open checkout URL or already-entitled state, existing entitlements use Stripe `customer`, first-time customers use `customer_email`, and no-token checkout still fails.
  - [x] 2.3 Update Stripe webhook handling to complete or expire pending checkout rows.
    - covers_prd: `FR-003`, `FR-005`
    - covers_tdd: `TDR-006`
    - output: `marketing-site/app/api/stripe/webhook/route.ts`, Supabase helper tests
    - verify: `cd marketing-site && bun test`
    - done_when: completed checkout marks the matching pending row completed and expired sessions can no longer be reused.

- [x] 3.0 Make claim conversion and linked retry semantics explicit
  - covers_prd: `FR-001`, `FR-002`, `FR-004`
  - covers_tdd: `TDR-002`, `TDR-007`, `TDR-010`
  - [x] 3.1 Update claim creation and conversion so linked same-user retry is allowed only through an install-origin token, while wrong-user, expired, and invalid token states stop with typed responses.
    - covers_prd: `FR-001`, `FR-002`, `FR-004`
    - covers_tdd: `TDR-002`, `TDR-007`, `TDR-010`
    - output: `marketing-site/lib/access/claim-eligibility.ts`, `marketing-site/app/api/trial/create-claim/route.ts`, `marketing-site/app/api/auth/convert-anonymous/route.ts`, tests
    - verify: `cd marketing-site && bun test`
    - done_when: linked non-active installs can mint an install-origin retry token, active/subscribed linked installs cannot mint unnecessary checkout tokens, linked same-user conversion proceeds with an explicit typed status, and all unsafe 409 cases remain blocked.
  - [x] 3.2 Update the claim page to branch on typed conversion results and avoid treating every 409 as checkout-safe.
    - covers_prd: `FR-004`, `FR-007`
    - covers_tdd: `TDR-007`
    - output: `marketing-site/app/(site)/claim/claim-flow.tsx`
    - verify: `cd marketing-site && bun test && npm run lint`
    - done_when: claim flow proceeds only for fresh link, same-user retry, or already-entitled states and shows actionable errors for invalid/expired/wrong-user states.

- [x] 4.0 Make rate limiting production-durable
  - covers_prd: `FR-006`
  - covers_tdd: `TDR-008`, `TDR-009`
  - [x] 4.1 Add durable rate-limit storage and refactor route callers to use it in production.
    - covers_prd: `FR-006`
    - covers_tdd: `TDR-008`, `TDR-009`
    - output: `marketing-site/lib/rate-limit.ts`, `marketing-site/app/api/trial/bootstrap/route.ts`, `marketing-site/app/api/trial/create-claim/route.ts`, `marketing-site/app/api/transcribe/cloud/route.ts`, migration/tests
    - verify: `cd marketing-site && bun test`
    - done_when: production mode no longer silently uses process-local memory, missing/unreachable durable storage returns a conservative retryable error, and tests cover durable-store success/failure plus local fallback.

- [ ] 5.0 Final verification and production-path probes
  - covers_prd: `FR-001`, `FR-002`, `FR-003`, `FR-004`, `FR-005`, `FR-006`, `FR-007`
  - covers_tdd: `TDR-001`, `TDR-002`, `TDR-003`, `TDR-004`, `TDR-005`, `TDR-006`, `TDR-007`, `TDR-008`, `TDR-009`, `TDR-010`, `TDR-011`
  - [ ] 5.1 Run focused and broad validation, plus local browser/API probes for the changed user paths.
    - covers_prd: `FR-001`, `FR-002`, `FR-003`, `FR-004`, `FR-005`, `FR-006`, `FR-007`
    - covers_tdd: `TDR-001`, `TDR-002`, `TDR-003`, `TDR-004`, `TDR-005`, `TDR-006`, `TDR-007`, `TDR-008`, `TDR-009`, `TDR-010`, `TDR-011`
    - output: validation evidence, preserved review/task artifacts as required by workflow
    - verify: `cd marketing-site && bun test && npm run lint && npm run build`; `bun run lint`; `bun run build`; `bun run check:translations`; targeted API/browser probes where local env permits
    - done_when: all in-scope automated checks pass or any residual unverified live Stripe/Supabase/desktop install path is explicitly recorded for final handoff.

# TDD: Production User Paths

## Source Interpretation

The implementation should follow existing Next.js App Router, Supabase REST helper, Stripe Checkout, Tauri command, Zustand store, and Bun/Rust test patterns already present in the repo. The design should extend the current Uttr dark marketing/account language, not introduce a new visual system.

## Technical Decisions

### TDR-1: Keep Stripe Checkout and Customer Portal

Use Stripe Checkout Sessions with `mode: "subscription"` for the first paid subscription and Stripe Customer Portal for self-service management. This matches current code and Stripe's recommended Billing + Checkout pairing.

### TDR-2: Download Is a Separate Site Action

Add a small marketing download helper that builds a configurable URL from env, with a GitHub latest-release fallback. Use normal links for download CTAs instead of the checkout/claim component.

### TDR-3: Claim Token Means Install-Linked Purchase

Retain the existing claim-token concept but broaden token creation so active trial users can upgrade early. Keep token redemption before checkout. Require claim context for first purchase so Checkout metadata always includes install linkage.

### TDR-4: Backend Refresh Is the Paid-State Source

Frontend `refreshInstallAccess` should call the backend-refresh Tauri command and fall back to local snapshot only when refresh fails. Rust premium commands should refresh entitlement before rejecting due to local cached state.

### TDR-5: In-Process Hardening First

Implement lightweight, deterministic in-memory rate limiting for the initial launch surface. It is not a substitute for infrastructure/WAF limits, but it blocks trivial repeated calls and is easy to test. Add usage quota checks using existing `usage_events` data.

### TDR-6: Tests Follow Existing Bun and Rust Patterns

Use existing `bun:test` tests in `marketing-site/lib/**` for pure helpers. Where routes need practical coverage, extract small pure helpers for request policy decisions rather than introducing a heavy Next route harness. Use targeted Rust tests where entitlement-refresh behavior can be checked without launching the desktop app.

## Implementation Notes

### Marketing and Claim UI

- Replace CTA usage on `marketing-site/app/page.tsx` and account download link with a dedicated download URL helper/component.
- Keep existing `CheckoutButton` only if it is renamed or limited to actual claim/checkout behavior.
- In `ClaimFlow`, add a no-token branch before auth UI. It should render download guidance and avoid loading sign-up/sign-in controls for unlinked visitors.

### Checkout and Claim APIs

- Update `/api/trial/create-claim` eligibility from expired-only to any unlinked install whose access state is `blocked`, `trialing`, or initial/new.
- Keep already-linked installs blocked.
- Update `/api/checkout` so missing `claim_token` returns a 400 unless the user already has active entitlement.
- Preserve Checkout Session metadata and subscription metadata with `source`, `user_id`, `anonymous_trial_id`, and `install_id`.

### Desktop Refresh

- Update `src/stores/settingsStore.ts` to use `commands.refreshInstallEntitlement()` for actual access refresh.
- Add an explicit cached snapshot loader where needed to avoid slow initial UI if necessary.
- Update `UpgradeButton` to avoid unlinked fallback.
- Update premium feature components/commands so a paid user gets a backend refresh before a final blocked decision.
- Preserve the existing app activation monitor and use the existing `install-access-changed` event path when available.

### Hardening

- Remove query-string token support from `marketing-site/lib/access/request.ts`.
- Add a small server helper for in-memory rate limiting keyed by route plus IP or install identity.
- Add usage-summary helper for recent trial usage and enforce request/audio limits before Groq.
- Update tests to prove blocked quota/rate-limit requests do not reach the provider helper path.

### CI and Validation

- Fix root lint literal-string issues and translation consistency failures.
- Add marketing-site lint/build to CI.
- Keep marketing-site unit tests runnable with Bun.

## Verification Strategy

### Automated Checks

- `bun test marketing-site/lib/access marketing-site/lib/groq marketing-site/lib/idempotency.test.ts marketing-site/lib/stripe.test.ts`
- `npm --prefix marketing-site run lint`
- `npm --prefix marketing-site run build`
- `npm run lint`
- `npm run check:translations`
- `npm run build`
- `cd src-tauri && cargo test access --quiet`

### Browser Checks

- Homepage download CTA goes to the configured download URL.
- `/claim` without token shows the download-first state and no auth form.
- Account page download guidance points to the real download URL.
- Success/account pages still render and preserve existing visual language.

### Manual/Integration Checks

- Fresh app install bootstraps a trial token.
- Active trial can create an upgrade/claim URL.
- Claim URL sign-up/sign-in links the install, starts Stripe Checkout, and webhook activation is visible through `/api/entitlement`.
- After returning from Stripe, desktop refresh unlocks Pro feature gates.

## Risk Notes

- In-memory rate limiting resets on server restart and may be per-instance in horizontally scaled deployments. It is a first-launch guardrail, not final abuse prevention.
- Removing query-string install tokens may break any undocumented manual tooling that depended on them. Current desktop code uses headers/body, so product paths should be unaffected.
- CI translation fixes may touch many locale files. Prefer existing fallback/copy convention rather than leaving the release gate red.

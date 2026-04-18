# PRD: Production User Paths

## Source Interpretation

This plan turns the production-readiness review into launch-blocking fixes for Uttr's real user paths: download the desktop app, use the hosted trial, upgrade from the app, complete Stripe Checkout, return to the app, and unlock Pro features. The central product decision is that first purchase must originate from a desktop install token; marketing pages may explain and route users, but must not create a paid subscription that is disconnected from an install.

## Goal

Make Uttr safe to deploy by ensuring paid subscriptions are install-linked, desktop activation refreshes immediately after payment, public hosted APIs have basic abuse controls, and the deployment checks cover both the desktop app and marketing site.

## Non-Goals

- No redesign of the full marketing site beyond the states required to clarify download versus app-origin subscription.
- No replacement of Stripe Checkout or Stripe Customer Portal.
- No new account system inside the desktop app.
- No production infrastructure outside the repo, except for env-driven links and route behavior that production can configure.

## Functional Requirements

### FR-1: Marketing Download Path

- Homepage and pricing "Download for macOS" actions must point to a real download path or configured release asset.
- Marketing pages must not label a claim or checkout flow as a download.
- The account page "Download the app" link must point to the same real download path.
- The download target must be configurable for production without code changes.

### FR-2: Claim Flow Requires App Origin

- `/claim` without `claim_token` must not show account creation, login, or checkout actions.
- `/claim` without `claim_token` must explain that users should download/open the app first, then start the subscription from the app.
- `/claim` with a valid `claim_token` must continue to support sign up, sign in, existing-session account choice, install linking, and checkout.

### FR-3: Install-Linked Upgrade Tokens

- The app's Upgrade action must obtain an install-linked token for eligible unlinked installs during `new`, `trialing`, or `expired` states.
- Already-linked installs must not receive a new claim token.
- BYOK-only users must not be forced into checkout when hosted access is unnecessary.
- If the app cannot create an install-linked upgrade token, it must show or log a useful failure and must not fall back to unlinked checkout.

### FR-4: Checkout Requires Linkage

- First purchase through `/api/checkout` must require a redeemed claim token and must include user, anonymous trial, and install metadata in the Checkout Session and subscription metadata.
- Existing active subscribers may still be routed to success/account management without a new claim token.
- Billing portal access remains authenticated and keyed by Stripe customer id from the user's entitlement.

### FR-5: Immediate Desktop Activation

- The desktop app must call the backend entitlement refresh when access state is used for upgrade, management, premium feature gates, and post-payment refresh.
- Cached local snapshots may be used for fast initial rendering, but they must not be the only source for paid/locked decisions after payment.
- File transcription and full-system audio gates must not stay blocked for a paid user because of stale local state.
- The app should refresh entitlement on activation/focus/wake when the existing activation bridge fires.

### FR-6: Public API Hardening

- Install tokens must no longer be accepted through query strings.
- Trial bootstrap, claim-token creation, and cloud transcription must have simple server-side rate limiting.
- Cloud transcription must enforce trial usage limits before calling Groq.
- Usage recording must happen early enough that provider cost is not incurred for requests that should already be blocked.

### FR-7: Validation and Deployment Gates

- Root lint and translation checks must be green.
- Marketing-site lint and production build must be represented in CI.
- Targeted tests must cover naked claim, linked checkout, active-trial upgrade token creation, entitlement refresh behavior, and hardening failure paths.
- Final validation must run relevant root, marketing, Rust, and focused test commands.

## UX Requirements

- The no-token claim state should be short, direct, and visually consistent with the existing dark glass marketing/account pages.
- Users should see one obvious primary action: download the app.
- Error states for upgrade-token failures should not send users into a broken payment path.
- Success page copy should align with the app refresh behavior.

## Trust and Security Requirements

- Public routes must not allow a browser-only account to create a paid entitlement that cannot be linked back to an install.
- Install tokens should travel in headers or JSON body only, not URLs.
- Rate limits and usage caps must be deterministic in-process safeguards suitable for first production traffic, while leaving room for external infrastructure limits later.
- Stripe remains the subscription source of truth; app access is derived from Supabase entitlement state synced from Stripe webhooks.

## Done When

- A user who has not downloaded Uttr cannot accidentally create an unlinked subscription from marketing pages.
- A trial user can click Upgrade in the app, complete Stripe Checkout, return to Uttr, refresh access, and see Pro features unlocked.
- A stale local access snapshot does not keep a paid user blocked.
- Hosted trial/proxy routes have basic abuse controls and tests.
- CI validates the root app and marketing site.

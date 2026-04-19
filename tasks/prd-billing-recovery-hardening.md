# Billing Recovery Hardening PRD

## Plain-Language Summary

Uttr should never send a real customer into a payment path that cannot work. If someone starts checkout from the app, creates an account, cancels, has a failed payment, retries after a webhook delay, or comes back after a trial expires, the app and site should choose the correct recovery path.

The first paid subscription must still begin from the desktop app so Pro access stays tied to the install. Once an install has been linked to an account, retries and billing recovery must use the linked account and Stripe customer state instead of pretending the user is a brand-new unlinked install.

The system should also stop duplicate Stripe sessions, make claim-token reuse explicit instead of accidental, and use production-safe rate limiting for public expensive routes. The result should be a production-ready billing path that is hard to double-charge and easy to recover from.

## Target User / Audience

- Uttr users installing the desktop app, starting a trial, upgrading to Pro, retrying failed checkout, updating a failed payment, canceling, or reactivating.
- The Uttr operator who needs reliable support behavior when Stripe webhooks, account auth, or desktop entitlement refreshes lag.

## Problem Statement

The production-readiness sweep found four concrete billing and abuse-control risks:

- Linked non-active users can be blocked because the desktop upgrade path always requests a first-purchase claim token, while linked installs are currently rejected by the claim endpoint.
- Checkout can create duplicate Stripe sessions because the server only checks current entitlement state and does not persist an in-flight checkout.
- The claim page treats every `convert-anonymous` 409 as safe to continue, which hides materially different states such as already redeemed, expired, wrong user, or same-user retry.
- Public rate limiting is process-local and header-derived, which is not durable enough for production.

## Current-State / Product Diagnosis

Uttr's current happy path is understandable: the desktop app creates an install-origin claim token, the user signs in on the claim page, the anonymous install links to the account, Stripe Checkout starts, and the webhook persists entitlement.

The weak point is recovery. A user can become linked before payment succeeds, a webhook can lag behind a successful checkout, a user can cancel or enter `past_due`, or a token can be retried. Those states need account-aware and install-aware recovery behavior instead of a single "create a fresh claim then checkout" action.

## Product Goal

Make billing recovery production-safe for linked and unlinked installs while preserving the product rule that the first Pro purchase must originate from the desktop app.

## Success Criteria

- A linked `past_due`, `canceled`, `expired`, or inactive user is no longer sent into a dead claim-token path.
- Repeated checkout attempts before webhook completion reuse an existing in-flight session or return the already-entitled state instead of creating duplicate subscriptions.
- Claim conversion responses distinguish same-user retry, wrong-user/token-invalid cases, and expired or already-used tokens.
- Public expensive endpoints use a production-durable rate limit store in production.
- Existing no-token `/claim` and signed-out checkout protections remain intact.

## Explicit Non-Goals

- Replacing Stripe Checkout with a custom payment form.
- Building a custom subscription management UI instead of using Stripe Checkout and Customer Portal where appropriate.
- Redesigning account authentication, pricing, or entitlement rules beyond the recovery states required here.
- Fixing unrelated dependency audit findings, format-check noise, or the unrelated Rust audio import test unless they block validation of this change.

## User Stories or Primary User Outcomes

- As a new user, I can start checkout only after opening Uttr and linking the install to my account.
- As a user who signed in and then canceled checkout, I can retry without creating multiple independent subscriptions.
- As a user whose card failed, I can get to the Stripe recovery path instead of being told to restart checkout from an impossible claim state.
- As a canceled or expired user, I can start a valid recovery or resubscribe path tied to my existing account.
- As the operator, I can trust that webhook delay and repeated clicks do not silently create duplicate sessions.

## Functional Requirements

- `FR-001` Preserve install-origin purchase gating for first Pro purchase. Checkout must not run from a naked site visit without a valid install-origin token or an already-linked account recovery state.
- `FR-002` Support linked non-active recovery. Linked installs with non-active entitlement states must have an actionable path: payment update, portal management, or resubscribe checkout.
- `FR-003` Prevent duplicate checkout creation. Repeated requests for the same user/install while a checkout is open must reuse or expire the pending session instead of creating unlimited new sessions.
- `FR-004` Make claim conversion states explicit. The claim page must proceed only when the server says the claim belongs to the current user or was freshly linked, and must stop for wrong-user, expired, invalid, or unrecoverable states.
- `FR-005` Keep entitlement source of truth on server-side persisted state and Stripe webhooks. Browser success redirects alone must not grant Pro.
- `FR-006` Use production-durable rate limiting for public expensive endpoints while keeping local development easy.
- `FR-007` Keep user-facing recovery copy direct and actionable without exposing internal billing implementation detail.

## Acceptance Criteria

- `FR-001`: Signed-out or no-token checkout still fails; `/claim` without token remains download-first.
- `FR-002`: Linked `past_due` and `canceled`/`expired` states no longer call a claim endpoint that rejects them without an alternate path.
- `FR-002`: Desktop billing UI does not show conflicting upgrade/manage actions for the same entitlement state.
- `FR-002`: Desktop billing states resolve to this product matrix:
  - subscribed/active: show account management only.
  - `past_due`: show a payment-update/account management action, not first-purchase checkout.
  - `canceled` or entitlement `expired`: show a reactivation checkout action tied to the install and existing account/customer when available.
  - entitlement `inactive` with linked trial: show app-origin checkout retry/reactivation, not a naked web checkout.
  - unlinked `new`, `trialing`, or expired trial: keep app-origin claim checkout.
- `FR-003`: Two checkout requests with the same valid install-origin token before webhook completion return the same open checkout session or an already-entitled response.
- `FR-003`: Completed webhook processing marks the pending checkout complete so later requests do not reuse stale pending state.
- `FR-003`: Existing Stripe customer IDs are reused for recovery/resubscribe checkout, while first-time customers still use account email prefill.
- `FR-004`: `convert-anonymous` returns machine-readable status for fresh link, same-user retry, wrong-user/token conflict, and expired/invalid token cases.
- `FR-006`: Production rate-limit checks use durable storage or an explicit production store path; in-memory limiting is not silently used as the production default.
- `FR-006`: When durable rate limiting is unavailable in production, public expensive routes return a conservative error instead of silently bypassing limits.

## Product Rules / UX Rules / Content Rules

- First purchase remains app-originated and install-linked.
- The account page remains the billing-management surface for signed-in account recovery.
- Stripe remains the hosted payment and subscription management UI.
- Error copy should tell users what to do next: sign in, retry from Uttr, update payment, or contact support.
- Desktop should refresh entitlement before deciding which billing action to show or open.

## Constraints and Defaults

- Use existing Supabase-backed billing and access storage unless implementation discovers a blocker.
- Use Stripe Checkout for subscription creation and Stripe Customer Portal for payment method and subscription management where it fits the state.
- Prefer small route/helper changes over broad auth or billing redesign.
- Keep local tests mock-backed where appropriate, but verify request shapes, persistence calls, and state transitions.

## Success Metrics / Guardrails

- No duplicate Stripe Checkout Session creation for the same user/install in the retry window.
- No linked non-active user state is left with only a rejected claim-token action.
- No regression to naked web checkout.
- No public route loses authentication, install-token, webhook-signature, or rate-limit protection.

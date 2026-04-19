# Sub-task 2.2 Contract

## goal

Harden `/api/checkout` so duplicate/retry requests reuse pending checkout sessions, existing Stripe customers are reused, and new Stripe session creation uses deterministic idempotency.

## in_scope

- Wire `/api/checkout` to pending checkout helpers from sub-task 2.1.
- Reuse an open pending checkout session for the same user/install context before creating a new Stripe Checkout Session.
- Use an existing entitlement `stripe_customer_id` as Stripe `customer`.
- Use `customer_email` only when no stored Stripe customer exists.
- Create new Stripe Checkout Sessions with an idempotency key derived from the stable pending checkout context.
- Persist newly created pending sessions.
- Add focused tests around request/session parameter construction or route behavior.

## out_of_scope

- Webhook completion/expiration marking; that is sub-task 2.3.
- Claim conversion status changes; that is task 3.0.
- Rate limiting.
- Customer Portal behavior.

## surfaces

- `marketing-site/app/api/checkout/route.ts`
- likely `marketing-site/lib/access/supabase.ts` if a conflict-safe insert/reuse helper is needed
- likely focused tests under `marketing-site/lib/` or route-adjacent helpers

## acceptance_checks

- Repeated checkout requests for the same user/install context return the existing open checkout URL instead of creating a second Stripe session.
- New Stripe session creation receives a deterministic idempotency key.
- Existing entitlement `stripe_customer_id` is passed as `customer`.
- First-time customers without a stored Stripe customer use `customer_email`.
- No-token checkout remains blocked with the existing "Start checkout from the Uttr desktop app" behavior.
- If pending-session persistence fails in production, checkout fails safely instead of creating an untracked duplicate-prone session.

## reference_patterns

- Existing `/api/checkout` route structure and `CheckoutRouteError`.
- Pending checkout helpers added in sub-task 2.1.
- Existing checkout metadata tests in `marketing-site/lib/stripe.test.ts`.
- Existing mocked fetch tests in `marketing-site/lib/access/checkout-sessions.test.ts`.

## test_first_plan

Prefer a focused pure-helper or route-level test before implementation. The red test should prove duplicate requests reuse an existing pending URL or that session creation receives `customer`/`customer_email` correctly. If route-level mocking is too brittle, extract a small helper for Checkout Session create params/idempotency key and test that first.

## verify

- `cd marketing-site && bun test`
- `cd marketing-site && npm run lint`

## verification_result

- `cd marketing-site && bun test lib/checkout.test.ts` passed.
- `cd marketing-site && bun test` passed.
- `cd marketing-site && npm run lint` passed.

## trust_boundary_notes

The route accepts authenticated Supabase bearer tokens and untrusted claim tokens. Do not loosen no-token, wrong-user, expired-claim, or active-entitlement behavior while adding dedupe.

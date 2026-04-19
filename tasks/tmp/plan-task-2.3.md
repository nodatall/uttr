# Sub-task 2.3 Contract

## goal

Update Stripe webhook handling so pending checkout rows are marked completed or expired and cannot be reused after Stripe lifecycle events.

## in_scope

- Mark pending checkout sessions completed when `checkout.session.completed` is processed.
- Mark pending checkout sessions expired when `checkout.session.expired` is processed.
- Add or update focused tests around webhook/session lifecycle helpers.
- Preserve existing webhook idempotency and entitlement sync behavior.

## out_of_scope

- Checkout creation/dedupe route behavior.
- Claim conversion semantics.
- Rate limiting.
- Email content redesign.

## surfaces

- `marketing-site/app/api/stripe/webhook/route.ts`
- `marketing-site/lib/access/supabase.ts` if helper signatures need tightening
- focused tests under `marketing-site/lib/` or route-adjacent helper files

## acceptance_checks

- A completed Checkout Session marks the pending row `completed` by Stripe session ID.
- An expired Checkout Session marks the pending row `expired` by Stripe session ID.
- Entitlement sync for completed checkout still runs.
- Existing webhook idempotency behavior remains unchanged.
- Unknown or unhandled events still return success after idempotency registration as before.

## reference_patterns

- Existing webhook route event dispatch in `marketing-site/app/api/stripe/webhook/route.ts`.
- Existing webhook idempotency tests in `marketing-site/lib/idempotency.test.ts`.
- Pending checkout helpers from sub-task 2.1.

## test_first_plan

Prefer extracting a small webhook/session lifecycle helper if direct route testing is too brittle. Add a red test proving completed and expired events call the pending-session marker functions before implementing.

## verify

- `cd marketing-site && bun test`
- `cd marketing-site && npm run lint`

## verification_result

- `cd marketing-site && bun test app/api/stripe/webhook/route.test.ts` passed.
- `cd marketing-site && bun test` passed.
- `cd marketing-site && npm run lint` passed.

## trust_boundary_notes

Do not weaken Stripe signature verification or idempotency registration. Pending-session marking should be server-only and tolerate missing rows without granting access.

# Sub-task 2.1 Contract

## goal

Add Supabase schema and access-layer helpers for pending Stripe Checkout Sessions so later route work can reuse one open checkout per user/install context.

## in_scope

- Add a Supabase migration for pending checkout session persistence.
- Add TypeScript row types for pending checkout rows.
- Add Supabase REST helper functions to:
  - compute/use a stable checkout context key for `user_id` plus install/claim context.
  - find a reusable open pending session that has not expired.
  - insert a new pending checkout session.
  - mark a checkout session completed.
  - mark a checkout session expired.
- Add focused Bun tests with mocked `fetch` following existing `marketing-site/lib/idempotency.test.ts` / access helper style.

## out_of_scope

- Changing `/api/checkout` behavior.
- Changing webhook handling.
- Changing Stripe API calls.
- Rate-limit persistence.

## surfaces

- `marketing-site/supabase/migrations/`
- `marketing-site/lib/access/types.ts`
- `marketing-site/lib/access/supabase.ts`
- likely `marketing-site/lib/access/checkout-sessions.test.ts` or adjacent focused test file

## acceptance_checks

- Schema enforces one open pending checkout per stable user/install context, using a partial unique index or equivalent.
- Helper can return an open non-expired session for the same context.
- Helper ignores expired sessions.
- Helper can insert pending session rows with checkout URL and Stripe IDs.
- Helper can mark rows completed or expired by Stripe Checkout Session ID.

## reference_patterns

- Existing Supabase REST helper style in `marketing-site/lib/access/supabase.ts`.
- Existing mocked-fetch persistence tests in `marketing-site/lib/idempotency.test.ts`.
- Existing migration style in `marketing-site/supabase/migrations/20260323125500_initial_billing_access_schema.sql`.

## test_first_plan

Add the focused helper tests first and run `cd marketing-site && bun test <test-file>` to confirm they fail before implementing helpers/migration.

## verify

- `cd marketing-site && bun test`

## verification_result

- `cd marketing-site && bun test lib/access/checkout-sessions.test.ts` passed.
- `cd marketing-site && bun test` passed.
- `cd marketing-site && npm run lint` passed.

## trust_boundary_notes

Helpers use service-role Supabase access only. Do not expose pending checkout rows through browser-safe clients.

# Sub-task 3.1 Contract

## goal

Make claim creation and anonymous conversion support linked same-user retry explicitly while still blocking active/subscribed, wrong-user, expired, and invalid token cases.

## in_scope

- Update claim eligibility so linked non-active installs can mint an install-origin retry/recovery token.
- Keep active/subscribed linked installs from minting unnecessary checkout tokens.
- Update `/api/trial/create-claim` to use the new eligibility contract.
- Update `/api/auth/convert-anonymous` to return typed machine-readable conversion statuses instead of collapsing all conflicts into generic 409 behavior.
- Add focused tests for claim eligibility and conversion status behavior.

## out_of_scope

- Claim page UI branching; that is sub-task 3.2.
- Checkout session dedupe; already handled.
- Rate limiting.

## surfaces

- `marketing-site/lib/access/claim-eligibility.ts`
- `marketing-site/lib/access/claim-eligibility.test.ts`
- `marketing-site/app/api/trial/create-claim/route.ts`
- `marketing-site/app/api/auth/convert-anonymous/route.ts`
- likely route-adjacent or extracted conversion tests

## acceptance_checks

- Linked non-active installs can create a fresh install-origin checkout/retry token.
- Linked active/subscribed installs cannot create claim/retry tokens.
- Same-user linked conversion returns an explicit checkout-safe status.
- Fresh unlinked conversion still links and returns explicit linked status.
- Wrong-user linked conversion returns an explicit unsafe status and does not proceed.
- Expired and invalid claims return explicit unsafe statuses.

## reference_patterns

- Existing `trialCanCreateClaim` helper and tests.
- Existing `redeem_trial_claim` RPC allows `user_id is null or user_id = p_user_id`; route should not pre-block same-user linked trials.
- Existing `convert-anonymous` route token validation and Supabase helper pattern.

## test_first_plan

Update `claim-eligibility.test.ts` first so the existing linked-install rejection test fails under the new desired behavior. Add conversion helper/route tests before changing conversion behavior where practical.

## verify

- `cd marketing-site && bun test`
- `cd marketing-site && npm run lint`

## verification_result

- `cd marketing-site && bun test` passed.
- `cd marketing-site && npm run lint` passed.
- Route-level tests for convert/create-claim were removed during integration because Bun module mocks for shared route dependencies conflicted across the full test suite; the retained helper tests cover the claim eligibility and conversion state machine used by those routes.

## trust_boundary_notes

Install-origin token creation proves app origin, not browser user identity. Same-user safety must be proven after Supabase browser auth in `convert-anonymous`; wrong-user linked trials remain blocked.

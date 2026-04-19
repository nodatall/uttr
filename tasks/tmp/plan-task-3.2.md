# Sub-task 3.2 Contract

## goal

Update the claim page so it branches on typed conversion results and no longer treats every `convert-anonymous` 409 as checkout-safe.

## in_scope

- Update `marketing-site/app/(site)/claim/claim-flow.tsx` to parse `status` and `checkout_safe` from `/api/auth/convert-anonymous`.
- Proceed to checkout only for `linked`, `already_linked_same_user`, or `already_entitled`/active-entitlement responses.
- Stop with actionable copy for `already_linked_different_user`, `expired_claim`, and `invalid_claim`.
- Preserve existing no-token download-first page behavior.
- Add focused tests if there is a practical local pattern; otherwise verify with marketing lint/build and final browser probe.

## out_of_scope

- Server route semantics.
- Checkout dedupe and webhook changes.
- Broad visual redesign of the claim page.

## surfaces

- `marketing-site/app/(site)/claim/claim-flow.tsx`
- possibly a tiny helper under `marketing-site/lib/` if status handling should be unit tested

## acceptance_checks

- 409 is no longer automatically checkout-safe.
- Fresh link and same-user retry proceed to checkout.
- Active/already-entitled response redirects to the returned success/account URL when provided.
- Wrong-user, expired, and invalid claim statuses show user-actionable errors and do not call `/api/checkout`.
- Existing signed-in/no-session/account creation behavior remains intact.

## reference_patterns

- Existing `readJsonError`, `startCheckout`, and error handling in `claim-flow.tsx`.
- Typed conversion statuses from `marketing-site/lib/access/claim-conversion.ts`.

## test_first_plan

If extracting a pure helper is clean, write a small failing test for conversion-status handling first. If not, record the exception and verify with `cd marketing-site && npm run lint && npm run build`, plus final browser/API probes.

## verify

- `cd marketing-site && bun test`
- `cd marketing-site && npm run lint`
- later finalization: `cd marketing-site && npm run build`

## verification_result

- `cd marketing-site && bun test` passed.
- `cd marketing-site && npm run lint` passed.
- `cd marketing-site && npm run build` passed.

## trust_boundary_notes

The browser must not decide that a failed conversion is safe based only on HTTP status. It should trust the explicit `checkout_safe` server field and block unknown or unsafe statuses.

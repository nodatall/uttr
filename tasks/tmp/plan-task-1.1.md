# Sub-task 1.1 Contract

## goal

Make desktop billing CTA selection explicit so each entitlement state has exactly one actionable path and linked non-active states no longer fall into a rejected first-purchase claim call.

## in_scope

- Add a small shared frontend helper for billing CTA visibility/action decisions if that fits the existing component structure.
- Update `UpgradeButton` and `ManageSubscriptionButton` to follow the plan matrix:
  - subscribed/active: account management only.
  - `past_due`: account/payment update only; no `createTrialClaim()`.
  - `canceled` or entitlement `expired`: reactivation checkout.
  - entitlement `inactive` with linked trial: app-origin checkout retry/reactivation.
  - unlinked `new`, `trialing`, or expired trial: app-origin claim checkout.
- Keep dev plan simulation and BYOK gating behavior coherent with existing helpers.

## out_of_scope

- Marketing-site API behavior.
- Stripe/Supabase persistence.
- Visual redesign beyond button labels/states required by the matrix.

## surfaces

- `src/components/settings/UpgradeButton.tsx`
- `src/components/settings/ManageSubscriptionButton.tsx`
- likely `src/lib/utils/premiumFeatures.ts` or a nearby utility

## acceptance_checks

- `past_due` entitlement state cannot call `commands.createTrialClaim()` from the upgrade CTA.
- `subscribed` remains management-only.
- `canceled`, entitlement `expired`, linked inactive, and unlinked first-purchase states still have a checkout/recovery action.
- The sidebar does not render two conflicting billing CTAs for the same active state.

## reference_patterns

- Existing access-state helper style in `src/lib/utils/premiumFeatures.ts`.
- Existing sidebar rendering in `src/components/Sidebar.tsx`.
- Existing Tauri command/open URL pattern in `UpgradeButton.tsx` and `ManageSubscriptionButton.tsx`.

## test_first_plan

No root frontend unit-test runner exists for these React helpers. Use a static red/green exception: implement the helper with narrow pure logic where possible and verify with `bun run lint` plus final `bun run build`.

## verify

- `bun run lint`
- later finalization: `bun run build`

## verification_result

- `bun run lint` passed.
- `bun run check:translations` passed after adding new sidebar copy keys to every locale.

## trust_boundary_notes

Desktop UI only chooses the entry point. Server routes remain responsible for auth, install-token validation, claim validation, and Stripe session creation.

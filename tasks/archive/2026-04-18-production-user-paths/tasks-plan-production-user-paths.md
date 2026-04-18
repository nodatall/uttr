# Tasks Plan: Production User Paths

## Relevant Files

- `marketing-site/app/page.tsx`
- `marketing-site/app/(site)/claim/page.tsx`
- `marketing-site/app/(site)/claim/claim-flow.tsx`
- `marketing-site/app/account/account-flow.tsx`
- `marketing-site/app/cancel/page.tsx`
- `marketing-site/app/success/page.tsx`
- `marketing-site/app/api/checkout/route.ts`
- `marketing-site/app/api/trial/create-claim/route.ts`
- `marketing-site/app/api/transcribe/cloud/route.ts`
- `marketing-site/lib/access/cloud-transcription-policy.ts`
- `marketing-site/lib/access/cloud-transcription-policy.test.ts`
- `marketing-site/lib/access/claim-eligibility.ts`
- `marketing-site/lib/access/claim-eligibility.test.ts`
- `marketing-site/lib/access/request.ts`
- `marketing-site/lib/access/request.test.ts`
- `marketing-site/lib/access/supabase.ts`
- `marketing-site/lib/access/usage.ts`
- `marketing-site/lib/access/usage.test.ts`
- `marketing-site/lib/checkout-policy.ts`
- `marketing-site/lib/checkout-policy.test.ts`
- `marketing-site/lib/download.ts`
- `marketing-site/lib/rate-limit.ts`
- `marketing-site/lib/rate-limit.test.ts`
- `marketing-site/lib/env.ts`
- `marketing-site/lib/stripe.test.ts`
- `marketing-site/app/globals.css`
- `src/stores/settingsStore.ts`
- `src/components/settings/UpgradeButton.tsx`
- `src/components/settings/ManageSubscriptionButton.tsx`
- `src/components/settings/file-transcription/FileTranscriptionSettings.tsx`
- `src/components/settings/RecordFullSystemAudio.tsx`
- `src-tauri/src/access.rs`
- `src-tauri/src/commands/transcription.rs`
- `.github/workflows/lint.yml`

## 1.0 Close Unlinked Marketing and Checkout Paths

- [x] 1.1 Add a configurable real app download URL and replace marketing/account download links with it. covers_prd: FR-1, FR-2 covers_tdd: TDR-2
- [x] 1.2 Change no-token `/claim` into a download-first informational state with no auth or checkout controls. covers_prd: FR-2 covers_tdd: TDR-2, TDR-3
- [x] 1.3 Require claim context for first checkout while preserving already-entitled account behavior. covers_prd: FR-4 covers_tdd: TDR-1, TDR-3

## 2.0 Make App-Origin Upgrade Tokens Work

- [x] 2.1 Allow unlinked new/trialing/expired installs to create an install-linked upgrade token and keep linked installs blocked. covers_prd: FR-3 covers_tdd: TDR-3
- [x] 2.2 Remove unlinked checkout fallback from the desktop Upgrade button and add a clear failure state. covers_prd: FR-3 covers_tdd: TDR-3, TDR-4
- [x] 2.3 Add targeted tests for checkout/token linkage and no-token claim behavior. covers_prd: FR-2, FR-3, FR-4 covers_tdd: TDR-6

## 3.0 Make Desktop Entitlement Refresh Real

- [x] 3.1 Update frontend access refresh to call backend entitlement refresh, with cached snapshot fallback only on refresh failure. covers_prd: FR-5 covers_tdd: TDR-4
- [x] 3.2 Refresh before premium feature lock decisions in settings UI and file transcription command paths. covers_prd: FR-5 covers_tdd: TDR-4
- [x] 3.3 Use app activation/focus refresh so returning from Stripe updates paid access promptly. covers_prd: FR-5 covers_tdd: TDR-4

## 4.0 Harden Public Hosted API Edges

- [x] 4.1 Remove query-string install token transport and update tests. covers_prd: FR-6 covers_tdd: TDR-5, TDR-6
- [x] 4.2 Add lightweight route rate limiting for bootstrap, claim-token creation, and cloud transcription. covers_prd: FR-6 covers_tdd: TDR-5
- [x] 4.3 Enforce trial usage quota before Groq transcription and add focused tests. covers_prd: FR-6 covers_tdd: TDR-5, TDR-6

## 5.0 Restore Release Gates and Final Evidence

- [x] 5.1 Fix current root lint and translation consistency failures. covers_prd: FR-7 covers_tdd: TDR-6
- [x] 5.2 Add marketing-site lint/build to CI. covers_prd: FR-7 covers_tdd: TDR-6
- [x] 5.3 Run final automated and browser validation for the production user paths. covers_prd: FR-7 covers_tdd: TDR-6

# Repo Sweep Round 1 Report - Main Baseline

## Audit Thesis

This sweep is a current `main`-based `$repo-sweep --swarm` run, not the earlier release-smoke branch review. The repository is in a strong local-test posture, but the highest production risk is at integration boundaries where local green tests can hide deploy-time failure modes: hosted marketing/API secrets, cloud transcription provider handling, request body admission, migration serialization, macOS permission/registration side effects, and release smoke reliability. The Round 1 repair strategy is to fix narrow, verified implementation defects that do not require a product/security policy decision, then resweep the same trust boundaries after validation.

## Baseline

- Repo: `/Volumes/Code/uttr`
- Branch: `main`
- Remote tracking: `main...origin/main`
- Baseline commit: `9e4495f` (`Merge pull request #6 from nodatall/deliver/release-transcribe-smoke`)
- Report timestamp: `2026-05-24T05:01:13Z`
- Working tree at report write time: dirty with in-progress sweep fixes, all uncommitted.
- Architecture doc: `docs/ARCHITECTURE.md` is absent.
- Design doc: `docs/DESIGN.md` exists; no production UI design changes are included in the current fix queue.
- Swarm coverage: security/privacy, intent/regression, reliability/ops, and contracts/coverage/maintainability lanes were used as candidate generators; findings below are the main-agent verified and classified set.

## Hotspots Inspected

- Tauri/macOS runtime: shortcut handling, autostart registration, tray/dev process behavior, release transcription smoke script, TextEdit paste target cleanup, generated smoke audio, screenshots, history verification, app profile migration path.
- BYOK and local secret storage: app settings surface, renderer redaction, migration behavior, local encrypted-by-file storage, keychain permission tradeoff.
- Marketing/API routes: checkout, trial bootstrap, anonymous conversion, cloud transcription proxy, billing portal, Stripe webhook, auth signup/signin/session routes.
- Hosted trust boundaries: access tokens, session signing, environment validation, Stripe webhook idempotency, rate limiting, trial/subscription usage accounting.
- Cloud provider boundary: Groq model selection, provider error handling, upload size admission, malformed multipart handling, usage accounting after provider success/failure.
- Operations/CI/release: PR workflow Rust coverage, mock-transcription test path, production Rust check gap, Next production build, migration runner locking.
- Test and artifact hygiene: route-level tests, release smoke screenshot artifacts, stale Tauri/Vite process interference, tracked historical review artifacts.

## Hotspots Intentionally Not Inspected

- Full notarized release packaging: outside Round 1 because the current fix queue is source/CI/test behavior, not signing/notarization. Packaging should be checked during a release candidate.
- Live production Stripe/Groq/database state: not inspected to avoid mutating customer/billing/provider state during a repo sweep. Local tests and builds covered code paths; live health checks remain release/deploy gates.
- Real model-download integrity pinning: inspected enough to classify the missing integrity manifest as residual risk, but not fixed because adding hashes requires a trusted release manifest/source-of-truth decision.
- Product-copy/UI redesign surfaces: intentionally not inspected deeply because the current findings are backend/runtime/test reliability. BYOK settings visibility is listed as a product-surface decision rather than silently changed.
- Historical archived task docs: not audited for correctness because they are not active runtime/build inputs. Existing stale artifacts are noted as cleanup risk only.

## Accepted Maintainability, Test-Quality, And Product-Surface Findings

- **Fix - production secret validation:** hosted token/session secrets were only checked for presence. Production could boot with placeholder or weak HMAC secrets. Repair in progress adds production-only secret strength/placeholder rejection in `marketing-site/lib/env.ts` and uses it for access/session signing.
- **Fix - cloud provider model/error contract:** cloud transcription accepted arbitrary client-requested Groq model names and could include provider response bodies in thrown/logged errors. Repair in progress constrains client-selected models to known transcription models and redacts provider error bodies.
- **Fix - upload admission before multipart parse:** cloud transcription only enforced upload limits through `Content-Length` when present, then parsed multipart data. Repair in progress rejects unknown-length uploads before `formData()` and converts malformed multipart bodies into 400s.
- **Fix - malformed JSON route behavior:** checkout, anonymous conversion, and trial bootstrap had inconsistent malformed JSON behavior, including generic exceptions or auth-first responses. Repair in progress adds client-error handling and route tests.
- **Fix - migration runner serialization:** marketing-site migrations had no advisory lock or statement/lock timeouts. Repair in progress adds a Postgres advisory lock and bounded timeouts.
- **Fix - autostart persistence ordering:** the app persisted autostart settings before OS registration succeeded. Repair in progress applies the OS autolaunch change first and only persists after success; startup reapply failures are logged.
- **Fix - release smoke TextEdit target cleanup:** the smoke test could leave or touch the wrong TextEdit document on failure. Repair in progress creates a unique scratch document, targets it by marker/name, closes it by name/path, and reruns the smoke.
- **Fix - PR CI coverage gap:** PR Rust CI only exercised the mock transcription path. Repair in progress adds a production Rust `cargo check --locked --lib --bin uttr` job.
- **Fix - route test gap:** trial bootstrap lacked even a malformed-body route test. Repair in progress adds the smallest route-level regression test for that path.
- **Human decision - BYOK/settings product surface:** API key settings visibility, validation status semantics, and local encrypted storage behavior need a product/security decision. The user previously rejected extra keychain permissions as a requirement, so this sweep does not silently switch storage back to keychain.
- **Human decision - usage accounting during provider call:** the cloud transcription route holds quota/advisory transaction state through an external provider call. Fixing that requires choosing reservation semantics and failure/refund behavior.

## Looks Bad But Fine

- `.env` is tracked, but current tracked contents are non-secret local Vite port variables. Real local secrets are in ignored `.env.local` files and were not printed.
- Stripe webhook is public, but it verifies Stripe signatures and uses durable idempotency before side effects.
- Broad CORS exposure was not found in the marketing/API routes during the sweep.
- Dev/mock access overrides are not available in production builds.
- BYOK secrets are no longer returned to the renderer in the repaired main history; renderer-facing settings are redacted.
- Release smoke screenshot artifacts are intentionally retained for evidence; sensitive app profile artifacts are scrubbed from the smoke scratch directory.
- Overlay progress being coverable by windows is expected for the current Tauri overlay implementation and was not treated as a regression here.
- Existing Rust dead-code warnings appear pre-existing and do not block the current production-check objective.

## Current Fix Queue

### Applied In The Dirty Worktree

- `marketing-site/lib/env.ts`, `marketing-site/lib/auth/server.ts`, `marketing-site/lib/access/tokens.test.ts`: production secret validation for access/session HMAC secrets.
- `marketing-site/lib/groq/transcription.ts`, `marketing-site/lib/groq/transcription.test.ts`: Groq client model allowlist/fallback and redacted provider errors.
- `marketing-site/app/api/transcribe/cloud/route.ts`, `marketing-site/app/api/transcribe/cloud/route.test.ts`: known-length upload admission and malformed multipart handling.
- `marketing-site/app/api/checkout/route.ts`, `marketing-site/app/api/checkout/route.test.ts`: malformed checkout JSON returns 400 consistently.
- `marketing-site/app/api/auth/convert-anonymous/route.ts`, `marketing-site/app/api/auth/convert-anonymous/route.test.ts`: malformed conversion JSON returns client error.
- `marketing-site/app/api/trial/bootstrap/route.ts`, `marketing-site/app/api/trial/bootstrap/route.test.ts`: malformed bootstrap JSON test/handling.
- `marketing-site/scripts/run-migrations.mjs`: advisory lock and timeout bounds for migrations.
- `src-tauri/src/shortcut/mod.rs`, `src-tauri/src/lib.rs`: autostart registration failure is no longer persisted silently.
- `.github/workflows/test.yml`: production Rust check added before the existing mock Rust test job.
- `scripts/release-transcribe-smoke.mjs`: TextEdit target uses a unique scratch document and closes it after success/failure.

### Not Applied Without A Human Decision

- Redesigning cloud usage accounting around provider-call reservation/refund semantics.
- Requiring release workflow smoke attestation before tag/manual release.
- Changing BYOK settings visibility, validation semantics, or local key storage permissions.
- Changing proxy IP trust rules for rate limiting.
- Changing transcript/audio retention defaults.
- Adding model-download integrity pinning without trusted hashes/manifest.
- Removing or rewriting historical preserved review artifacts.

## Validation Already Run

- `bun run format:check` - pass after the final smoke-script targeting patch.
- `bun run lint` - pass.
- `bun run check:translations` - pass.
- `npm --prefix marketing-site run lint` - pass.
- `npm --prefix marketing-site test` - pass, 110 tests.
- `npm --prefix marketing-site run build` - pass.
- `bun run build` - pass.
- `cargo check --manifest-path src-tauri/Cargo.toml --locked --lib --bin uttr` - pass, pre-existing warnings only.
- `cargo test --manifest-path src-tauri/Cargo.toml --quiet` - pass, 198 passed, 1 ignored.
- Mock-transcription CI simulation with `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --quiet` after temporary source/dependency swap - pass, 176 passed; temporary lockfile churn was restored.
- `git diff --check` - pass.
- `node --check scripts/release-transcribe-smoke.mjs` - pass after final smoke-script patch.
- `node --check marketing-site/scripts/run-migrations.mjs` - pass.
- `bun run test:e2e:release-transcribe` - pass after the final smoke-script patch. Evidence: `agents-scratch/release-transcribe-smoke/2026-05-24T05-12-17-727Z/screenshots` with recording, transcribing, pasted result, settings, and history screenshots.

## Final Resweep Result

- Resweep timestamp: `2026-05-24T05:13:31Z`.
- Security/privacy lane: no new fix-class findings. Looks-bad-but-fine items were production-only secret enforcement, server-controlled Groq default model, deliberate rejection of chunked uploads, checkout parsing before session auth after rate limiting, migration advisory lock behavior, and best-effort smoke cleanup.
- Ops/reliability lane: found two P3 TextEdit smoke issues. Both are fixed: the smoke target is now marked immediately after `open`, cleanup closes by target identity even after setup failure, and focus requires the named TextEdit window rather than falling back to any `window 1`.
- Maintainability/test-quality lane: found one P3 env-restore issue and the same TextEdit target issues. The bootstrap route test now uses delete-or-restore `NODE_ENV` cleanup, and pasted-text reads now target the named smoke document.
- Local final diff inspection found no lockfile churn, no generated binding churn, and no accidental tracked smoke artifacts.
- Remaining items are explicitly classified as human-decision/residual risks rather than fix queue items for this sweep.

## Validation Still Pending

- None for the current `$repo-sweep --swarm` repair/resweep loop.
- Committing, branching, shipping, or resolving human-decision residual risks remains outside this sweep completion unless requested separately.

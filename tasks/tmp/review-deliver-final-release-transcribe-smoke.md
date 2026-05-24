# Final Review: Release Transcribe Smoke Test

Scope reviewed: `package.json`, `scripts/release-transcribe-smoke.mjs`, `scripts/release-local.sh`, and `tasks/execution-plan-release-transcribe-smoke.md`.

## Checks

- [x] The implementation matches the reviewed Deliver plan.
- [x] The smoke test keeps the shortcut, live microphone recording window, overlay log assertion, transcription completion, and paste assertion in the tested path.
- [x] The smoke test uses an isolated `HOME` and isolated `settings_store.json` so normal Uttr settings and BYOK secret files are not read or migrated.
- [x] The smoke test fails before launch unless a real provider is configured through an API-key environment variable or an explicit local Parakeet model directory.
- [x] The release wrapper runs the smoke command before `gh workflow run release.yml --ref main`.
- [x] The release wrapper refuses to run unless the current branch is clean `main`, local `main` matches `origin/main`, and version files agree.
- [x] Validation evidence is recorded below.

## Findings

No in-scope material findings.

## Residual Risk

The full native smoke flow was not run in this Codex turn because it intentionally requires an operator to speak the prompted phrase into the live microphone. The local preflight path was run against the existing Parakeet v3 model directory and verified provider selection, isolated app-data creation, and seeded smoke settings.

## Validation

- `node --check scripts/release-transcribe-smoke.mjs`
- `bash -n scripts/release-local.sh`
- `bunx prettier --check package.json scripts/release-transcribe-smoke.mjs`
- `bash scripts/release-local.sh --help`
- `node scripts/release-transcribe-smoke.mjs --help`
- `UTTR_RELEASE_SMOKE_MODEL_DIR="$HOME/Library/Application Support/com.pais.uttr/models/parakeet-tdt-0.6b-v3-int8" node scripts/release-transcribe-smoke.mjs --preflight-only`
- `UTTR_RELEASE_SMOKE_MODEL_DIR="$HOME/Library/Application Support/com.pais.uttr/models/parakeet-tdt-0.6b-v3-int8" bun run test:e2e:release-transcribe --preflight-only`
- `osascript` local automation probes for System Events access and existing Uttr process detection
- `git diff --check`

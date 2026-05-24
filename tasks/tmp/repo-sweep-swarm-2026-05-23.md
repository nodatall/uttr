# Repo Sweep Swarm - 2026-05-23
Command: `$repo-sweep --swarm --preserve-review-artifacts` Branch: `deliver/release-transcribe-smoke` Base: `origin/main` / current branch history Mode: no-edit report first, then goal-mode repairs for verified safe findings.
## Baseline
- `git status --short --branch`: 17 dirty files at kickoff, all pre-existing to this {==sweep turn.==}{>>hello<<}{id="c1" by="user" at="2026-05-24T02:06:53.147Z"}
  
- Recent branch commits include release smoke automation, BYOK secret movement, TextEdit cleanup, screenshot capture, and artifact scrubbing.
  
- Current dirty files include formatting churn, `src/App.tsx` onboarding callback {==stabilization, `tests/e2e/full-system-audio.spec.ts` fixture updates, `.playwright-mcp` snapshots, and mockup/doc formatting changes.==}{>>e222<<}{id="c2" by="user" at="2026-05-24T02:07:02.025Z"}
  
- {==`docs/ARCHITECTURE.md` is absent; `docs/DESIGN.md` exists.==}{>>e222<<}{id="c2" by="user" at="2026-05-24T02:07:02.025Z"}
  
## Commands Run During No-Edit Pass
- `git status --short --branch`
  
- `git log --oneline --decorate -12`
  
- `git diff --stat`
  
- `git diff --name-only`
  
- `git diff -- src/App.tsx tests/e2e/full-system-audio.spec.ts src/components/settings/PostProcessingSettingsApi/usePostProcessProviderState.ts src/components/ui/Textarea.tsx`
  
- `git diff -- marketing-site/app/download/route.ts marketing-site/app/page.tsx marketing-site/lib/download.ts`
  
- package script inventory for root and `marketing-site`
  
- public route inventory under `marketing-site/app/api` and `marketing-site/app/download`
  
- Tauri command and runtime surface inventory under `src-tauri/src`
  
- secret/artifact/destructive-path scans with `rg`
  
- `git diff --check`
  
- `bun run format:check`
  
- `bun run lint`
  
- latest smoke screenshot review from `agents-scratch/release-transcribe-smoke/2026-05-23T04-32-24-988Z/screenshots`
  
## Swarm Lanes
- Intent and Regression: agent `019e55c7-3dc0-77b3-94bc-816b23d3c4e2`
  
- Security and Privacy: agent `019e55c7-5345-7ab0-98d8-b9ad98df6719`
  
- Performance and Reliability: agent `019e55c7-6ae2-7622-bc6b-9d087e7f252f`
  
- Contracts and Coverage: agent `019e55c7-803f-7121-a433-a2e2a465db84`
  
- Maintainability and Slop: agent `019e55c7-976b-7f01-a560-f216c7e492c1`
  
## No-Edit Findings
### Finding 1: Release Smoke Screenshots Do Not Prove The Requested Visible States
- Severity: P2
  
- Execution gate: fix before completion
  
- Disposition: fix
  
- Confidence: high
  
- Scope: `scripts/release-transcribe-smoke.mjs` and latest smoke evidence.
  
- Evidence: latest screenshot hashes show `03-pasted-result.png` and `04-history.png` are identical. Visual inspection shows Chrome frontmost in all four screenshots, not the Uttr overlay, TextEdit pasted result, settings page, or History view. Logs still prove backend events (`overlay shown state=recording`, `overlay shown state=transcribing`, `Text pasted successfully`, and `Release smoke history entry saved id=1`), so this is an evidence-capture failure rather than a transcription failure.
  
- Impact: The test can pass while failing the user's explicit acceptance: screenshots of recording animation/tray icon, transcribing, pasted result, and history.
  
- Fix path: before screenshots, explicitly focus or expose the target UI state and assert it is visible enough to capture. Capture a dedicated visible marker for TextEdit and History, and fail if the screenshot evidence is still identical or missing the intended app.
  
- Owner: main agent.
  
### Finding 2: Release Smoke Uses SIGUSR2 Instead Of The Configured Shortcut
- Severity: P2
  
- Execution gate: fix before completion
  
- Disposition: fix
  
- Confidence: high
  
- Scope: `scripts/release-transcribe-smoke.mjs`, `src-tauri/src/signal_handle.rs`.
  
- Evidence: the script seeds `command+shift+9` but calls `triggerSmokeToggle()`, which sends `kill -USR2` to the app. Logs show `Received SIGUSR2 transcription toggle request`. This bypasses global shortcut delivery even though the release smoke contract says shortcut delivery must be real.
  
- Impact: The release smoke can pass while the actual configured shortcut path is broken.
  
- Fix path: trigger the seeded shortcut through local keyboard automation by default. Keep SIGUSR2 only as an explicit debug fallback if needed, not the release smoke path.
  
- Owner: main agent.
  
### Finding 3: API Route Body Parsing Is Inconsistent
- Severity: P3
  
- Execution gate: no action during this repair unless adjacent tests are already open
  
- Disposition: residual risk
  
- Confidence: medium
  
- Scope: `marketing-site/app/api/**/route.ts`.
  
- Evidence: the maintainability lane found sign-in/sign-up guard invalid JSON with `request.json().catch(() => ({}))`, while checkout, trial bootstrap, convert-anonymous, and cloud transcribe parse body/form data inside broad 500 catch paths.
  
- Impact: malformed client payloads can become noisy 500s instead of client errors.
  
- Fix path: add shared parsing helpers or consistently catch malformed payloads, then add route tests. This is outside the release-smoke repair unless the user wants broader API cleanup.
  
- Owner: future main agent.
  
### Finding 4: Full-System Audio Browser Fixture Protects A Non-Production macOS Shortcut String
- Severity: P3
  
- Execution gate: fix if already touching this test file
  
- Disposition: fix
  
- Confidence: high
  
- Scope: `tests/e2e/full-system-audio.spec.ts`.
  
- Evidence: the test mocks macOS but seeds and asserts `ctrl+alt+space`; Rust defaults and migration tests use `ctrl+fn` for this binding.
  
- Impact: the browser test can preserve an impossible macOS default.
  
- Fix path: seed/assert the production macOS default or assert against the semantic mocked binding intentionally.
  
- Owner: main agent if this file remains in scope.
  
### Finding 5: Successful Smoke Artifacts Are Preserved By Default
- Severity: P3
  
- Execution gate: no action during this repair unless changing screenshot retention
  
- Disposition: residual risk
  
- Confidence: medium
  
- Scope: `scripts/release-transcribe-smoke.mjs`.
  
- Evidence: help documents `--keep-artifacts`, but screenshot capture sets `preserveArtifacts = true`, so default successful runs keep artifacts.
  
- Impact: successful runs accumulate screenshots, logs, pasted transcript text, and DB artifacts in `agents-scratch`.
  
- Fix path: document that screenshots are always retained as release evidence, or make retention opt-in and copy only selected proof artifacts.
  
- Owner: future main agent unless retention semantics are changed now.
  
### Finding 6: Tracked `.playwright-mcp` Snapshots Are Noisy Generated Artifacts
- Severity: P3
  
- Execution gate: no action during this repair
  
- Disposition: residual risk
  
- Confidence: medium
  
- Scope: `.playwright-mcp/*.yml`, `.gitignore`.
  
- Evidence: eight tracked snapshots are dirty with generated formatting churn and stale mockup copy.
  
- Impact: reviewers must separate generated browser residue from product changes.
  
- Fix path: move durable evidence to `tasks/tmp/` or archive docs, untrack `.playwright-mcp`, and ignore future snapshots.
  
- Owner: future main agent or explicit cleanup task.
  
## Looks Bad But Fine
- Root `.env` is ignored for future changes and tracked content was previously verified as only Vite port names, not secrets.
  
- `src-tauri/src/byok_secrets.rs` is sensitive but has renderer redaction, placeholder filtering, private file writes, env override priority, legacy migration guards, and focused tests.
  
- `agents-scratch/release-transcribe-smoke` is ignored and current profile secret files (`byok_secrets.json`, `byok_secrets.key`, `byok.vault`, `settings_store.json`) were not found under retained smoke artifact dirs.
  
- `marketing-site/lib/download.ts` defaulting to `/download` is intentional because the route resolves latest DMG assets and falls back to GitHub Releases.
  
## Current Repair Queue
1. ~~Fix release smoke to exercise real shortcut delivery and capture meaningful visual states.~~ Done.
  
2. ~~Align full-system audio e2e fixture with the production macOS shortcut default while the file is already dirty.~~ Done.
  
3. ~~Rerun focused tests, native smoke, and broad validation.~~ Done.
  
4. Resweep for remaining `Disposition: fix` findings.
  
## Repair Pass
### Fixed Finding 1: Release Smoke Screenshots Prove Visible States
- Removed the SIGUSR2 release-smoke path and trigger the configured `command+shift+9` shortcut through CoreGraphics key events.
  
- The smoke now waits for handy-keys shortcut registration before recording.
  
- It captures five non-identical screenshots:
  
  - `01-recording.png`
    
  - `02-transcribing.png`
    
  - `03-pasted-result.png`
    
  - `04-settings.png`
    
  - `05-history.png`
    
- Latest verified evidence: `/Volumes/Code/uttr/agents-scratch/release-transcribe-smoke/2026-05-23T17-27-15-405Z/screenshots`.
  
- Visual inspection confirmed `05-history.png` shows the History tab selected and the `Release smoke test.` entry visible.
  
### Fixed Finding 2: Release Smoke Uses Real Shortcut Delivery
- Removed `UTTR_ENABLE_SIGUSR2_TRANSCRIPTION` from the release-smoke app environment.
  
- Removed waiting for `SIGUSR2 transcription toggle enabled`.
  
- Added a Swift CoreGraphics helper generated inside the scratch directory to emit modifier-change and key down/up events for the configured shortcut.
  
- Latest smoke logs show `handy-keys event: binding=transcribe, hotkey=command+shift+9` before recording starts.
  
### Fixed Finding 4: Full-System Audio Fixture Uses Production macOS Shortcut
- Updated the browser fixture and assertion copy to use `ctrl+fn`, matching the Rust default and migration path for macOS.
  
- Verified by `bun run test:playwright`.
  
### Additional Safe Repairs
- Copied legacy `byok.vault` into the isolated release-smoke profile before scrubbing, so legacy Stronghold migrations are covered by the same smoke setup.
  
- Narrowed the Tauri renderer filesystem scope from all app data to `recordings` only, keeping History audio playback while removing renderer file access to BYOK secret files.
  
- Added post-smoke `main` / `origin/main` rechecks before release workflow dispatch in `scripts/release-local.sh`.
  
- Release smoke now closes its own TextEdit document, closes empty TextEdit leftovers created during smoke attempts, and quits TextEdit only when no documents remain. It intentionally leaves pre-existing non-empty TextEdit documents open.
  
## Verification
- `node --check scripts/release-transcribe-smoke.mjs`
  
- `bun run format:check`
  
- `bun run lint`
  
- `bun run test:e2e:release-transcribe`
  
- `bun run test:playwright`
  
- `bun run build`
  
- `bun run check:translations`
  
- `cargo test --quiet` from `src-tauri`
  
- `bun run test` from `marketing-site`
  
- `bun run lint` from `marketing-site`
  
- `bun run build` from `marketing-site`
  
- `git diff --check`
  

Notes:

- `cargo test --quiet` passed with existing dead-code warnings.
  
- TextEdit remained running after the final smoke only because a pre-existing non-smoke `Untitled 4` document contained `probe`; the smoke-created document was closed.
  
- Retained smoke artifacts were scrubbed of `settings_store.json`, `byok_secrets.json`, `byok_secrets.key`, and `byok.vault`.

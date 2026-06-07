## General Rules

- Make the smallest change that solves the request.
- Match the surrounding code style.
- Do not refactor or clean up unrelated code.
- Do not revert or overwrite user changes unless explicitly asked.
- Ask only when the answer would change the implementation.
- Prefer existing tests for changed code paths.
- If no test covers the path, run the exact function or code path you changed with realistic inputs.
- Regression fixes should add or update the smallest practical test/check that would have caught the regression.
- Put disposable agent-created probes, scripts, and one-off benchmarks in `/agent-scratch/` unless the repo already has a better temp convention.
- Treat `/agent-scratch/` as disposable and gitignored; promote useful checks into real tests, benchmarks, or docs.
- For UI, layout, styling, or product-surface changes, read `docs/DESIGN.md` before editing when present.
- For any UI, layout, styling, or rendered-content change, inspect the affected UI in a browser or app when practical. Capture a screenshot of the changed state, visually check it for layout, clipping, spacing, copy, and responsive issues, and mention the evidence in the handoff. If the UI cannot be run, state why.
- For backend, integration, runtime, deployment, or agent/tooling changes, capture the current state before editing: relevant routes, config, env var presence, schema/migrations, services, provider state, and validation commands. Prefer structured output such as `--json`, health checks, metadata commands, or diagnostics when available, and do not expose secret values. After the first failed runtime or integration attempt, classify the failure layer before patching again.
- Do not claim success until the relevant check has run or you clearly state what could not be checked.
- Before boundary-affecting work, read `docs/ARCHITECTURE.md` when it exists.

## Verification

- Frontend changes: run `bun run build`; run `bun run lint` when JS/TS/React files change.
- Rendered UI changes: run `bun run test:playwright` or inspect with Browser and mention the screenshot/visual evidence.
- Rust/Tauri changes: run `cd src-tauri && cargo test`, preferably targeted to the changed module first.
- Native macOS behavior changes: run `bun run tauri:build:fast`.
- Transcription, paste, overlay, shortcut, or permissions changes: run `bun run test:e2e:release-transcribe -- --preflight-only`; run the full smoke test when local permissions/automation allow it.
- If the relevant check cannot run, state the exact blocker and do not claim the fix works.

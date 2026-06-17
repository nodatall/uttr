# React Top-Level Flow Performance Goal

This should run as a Codex `/goal`, not a normal implementation checklist.

Please review this before I start.
Tell me what is wrong, missing, or out of order.

If this looks right, say: `start this as a goal`.
Do not approve this as a normal implementation checklist.

## How To Start This Goal

When this looks right, the agent should print a separate paste-ready `/goal` prompt in chat. That prompt must reference this file by absolute path instead of duplicating the plan text.

Do not copy this Markdown file into `/goal`.

## Why This Is A Goal

- The work covers every meaningful top-level React page or flow, but the pages that actually need code changes must be selected by measurement.
- The implementation step for each flow depends on the measured cause: bundle loading, eager data work, repeated render work, store subscriptions, expensive lists, warnings/errors, or no safe local bottleneck.
- The loop is adaptive: measure all flows, identify budget or peer outliers, patch the highest-confidence bottleneck for one outlier, re-measure the same matrix, and continue until every flow is within budget or has a proven no-safe-fix blocker.

## Plain Language Summary

Measure every meaningful top-level React page and flow in Uttr, then optimize the ones that are actually slow. The agent should not stop after fixing one page if another measured flow still exceeds budget or is meaningfully slower than its peers. Success means each measured flow has a baseline, a final measurement, and either a passing budget or a documented reason that further safe optimization is not practical.

## Starting Evidence

- Source request: "Measure every meaningful top-level React page/flow in `/Volumes/Code/uttr`. For each flow that exceeds the documented budget or is meaningfully slower than peers, fix the highest-confidence bottleneck, re-measure, and repeat until all measured flows are within budget or a no-safe-fix blocker is proven. Leave behind a regression check or documented budget for every measured flow."
- Local repo shape: Vite, React 18, Bun scripts, Tauri desktop app shell.
- Relevant scripts from `package.json`: `bun run build`, `bun run lint`, `bun run test:playwright`, `bun run tauri:build:fast`, and `bun run test:e2e:release-transcribe -- --preflight-only`.
- Playwright config uses `http://localhost:1420` with `bunx vite dev`.
- Top-level app surfaces are selected through `src/components/sidebarSections.ts`: Meetings, Files, Transcriptions, Settings, and debug/subscription-gated Models/API Keys.
- Main app composition is in `src/App.tsx`, with workspace surfaces under `src/components/workspace/` and settings surfaces under `src/components/settings/`.
- Design and architecture sources exist and must be respected: `docs/DESIGN.md` and `docs/ARCHITECTURE.md`.
- Existing Playwright coverage starts in `tests/app.spec.ts` and `tests/e2e/full-system-audio.spec.ts`; additional disposable probes belong in `/agent-scratch/` unless promoted into a real test.
- Prior narrow pass artifacts may exist under `agent-scratch/react-performance/` and `tasks/react-performance-budget.md`. Treat them as useful starting evidence, not as proof that the broader all-flow goal is complete.

## Target and baseline:

- Current baseline: must be remeasured at the start of the goal against the current checkout. Include app startup and every meaningful top-level sidebar page/flow that can be exercised locally with stable mocks: Meetings startup/home, Settings, Files, Transcriptions, Models, API Keys, and any other top-level React surface discovered during inspection.
- Provisional budgets until the goal refines them with measured noise:
  - Startup/home ready: median at or below 90 ms and mean at or below 130 ms on the local repeated-run benchmark.
  - Top-level page/flow switches: median at or below 60 ms and mean at or below 80 ms on the same benchmark shape.
  - Console health: no repeated startup or flow-specific warnings/errors.
- Peer outlier rule: even if a flow is under budget, inspect it when its median is more than about 25% slower than comparable top-level page switches and the difference is larger than observed run-to-run noise.
- Target: every measured top-level flow is within budget and not a meaningful peer outlier, or has a documented no-safe-fix blocker. Every measured flow must be represented in a regression check or documented budget.
- Work backward from the target when choosing diagnostics and patches.

## Work Loop

1. Read `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/DESIGN.md`, the `react-best-practices` skill, the `frontend-testing-debugging` skill, and the Browser skill if available.
2. Capture the current state before editing: `git status --short`, package scripts, Playwright setup, local dev server behavior, current performance/budget artifacts, and the full set of meaningful top-level React flows.
3. Define the measurement matrix before patching. Prefer Browser or Playwright evidence that can run repeatedly against the same URL, viewport, mocks/data state, and interaction paths. Store disposable probes and raw outputs in `/agent-scratch/`.
4. Measure every meaningful top-level flow in one baseline run. Record median, mean, min, max, sample count, URL, viewport, ready signal, console warnings/errors, and any known source of measurement noise.
5. Compare the matrix against the documented/provisional budgets and peer-outlier rule.
6. Pick the single highest-confidence outlier bottleneck. Apply the most relevant `react-best-practices` rule with the smallest useful change, favoring measured waterfalls, bundle weight, eager locale/module loading, expensive render work, repeated lookups, unnecessary subscriptions, or non-urgent updates.
7. Re-run the same full matrix, not just the changed page. Confirm the patch improves the target flow without regressing other measured flows beyond budget/noise.
8. Repeat steps 5-7 for the next remaining budget or peer outlier until all flows pass or a no-safe-fix blocker is proven.
9. Add or update the smallest practical regression check, benchmark, Playwright assertion, or documented budget covering every measured flow. If durable automation would be brittle or noisy, document the budget and exact manual/temporary measurement command.
10. Run required supporting checks for the files changed.

## Primary Verifier

- A repeatable Browser or Playwright performance matrix covering every meaningful top-level React page/flow, with baseline and final measurements for the same URL, viewport, mocks/data state, interaction paths, ready signals, and sample counts. It decides success only when every measured flow is within budget and not a meaningful peer outlier, or the remaining outlier has a documented no-safe-fix blocker. The verifier must also include rendered proof that representative affected flows still reach the expected UI state with no relevant framework overlay or fresh app console errors.

## Supporting Checks

- `bun run build`.
- `bun run lint` when JS, TS, React, or CSS files change.
- `bun run test:playwright` or focused Playwright commands that cover changed rendered flows. If the Browser plugin is used instead, record URL, viewport, DOM/screenshot evidence, console health, and interaction proof.
- If native macOS, shortcut, overlay, permissions, paste, transcription, or Tauri behavior is touched, run the matching repo checks from `AGENTS.md`, including `bun run tauri:build:fast` and/or `bun run test:e2e:release-transcribe -- --preflight-only`.
- If a regression check or benchmark is added, run it directly and include its command and result.

## Acceptance Criteria

- Every meaningful top-level React page/flow has a baseline measurement and a final measurement using the same matrix.
- Every flow is under its documented budget and not a meaningful peer outlier, or has a specific no-safe-fix blocker with evidence.
- Each optimized flow has a named bottleneck, a before/after comparison, and a concise reason the chosen patch was the highest-confidence fix.
- The final measurement matrix shows no uninvestigated regressions in other measured flows.
- A regression check or documented budget covers every measured flow, not only startup.
- Rendered behavior for representative affected flows is verified with Browser or Playwright evidence.
- Required supporting checks pass, or any blocked check is reported with the exact blocker and residual risk.
- The goal does not violate `docs/DESIGN.md`, `docs/ARCHITECTURE.md`, or `AGENTS.md`.

## Anti-Cheat Criteria

- Do not count success by measuring fewer flows after the patch than before it.
- Do not count success by changing routes, viewport, data state, interaction paths, build mode, cache state, ready signals, sample counts, or metrics between baseline and final measurements.
- Do not treat moving startup cost into first page click as success unless the full matrix shows every affected flow remains within budget and not a peer outlier.
- Do not crop evidence to hide slow states, framework overlays, console errors, loading stalls, layout breakage, or missing content.
- Do not weaken, skip, delete, or rename tests to create a passing result.
- Do not remove user-visible functionality, accessibility affordances, translations, loading states, error handling, or safety checks to make a flow look faster.
- Do not add dependencies, change package managers, alter native/Tauri behavior, or change production data/storage without evidence that it is necessary and within scope.
- Do not leave disposable probes, screenshots, traces, or reports in committed source unless they are intentionally promoted into a real test, benchmark, or documentation artifact.

## Stop Conditions

- Stop as complete only when: the full top-level flow matrix has comparable baseline/final evidence, every measured flow is within budget and not a meaningful peer outlier or has a documented no-safe-fix blocker, rendered behavior is verified, required supporting checks pass or are explicitly blocked, and a regression check or documented budget covers every measured flow.
- Stop as blocked only when: a missing credential, unavailable local dependency, broken dev server that cannot be repaired safely, unavailable Browser/Playwright runtime with no allowed fallback, required native permission, destructive action, or user decision prevents useful local progress across the remaining outliers.
- Do not stop just because: one flow improved, the first measurement is noisy, one validation failed, a suspected bottleneck was wrong, a sub-step finished, tests are slow, the result is confusing, or more diagnostics are needed.
- If interrupted by compaction, context loss, usage limit, or time budget before a stop condition is met, update `Resume State` and leave the goal incomplete.

## Resume State

- Current status: complete
- Current phase: final validation complete
- Last completed step: measured the full top-level React flow matrix, confirmed every measured flow is within budget, confirmed peer gaps are below meaningful-noise threshold, documented the per-flow budget, and verified representative rendered states.
- Active step: none
- Next exact action: none for this goal; future regressions should rerun the documented matrix before patching.
- Blockers: none
- Last validation:
  - Controlled before matrix: `agent-scratch/react-performance/controlled-before-direct-imports-2026-06-17-run1.json` and `agent-scratch/react-performance/controlled-before-direct-imports-2026-06-17-run2.json` passed with zero console warnings/errors.
  - Controlled after matrix: `agent-scratch/react-performance/controlled-after-defer-device-refresh-2026-06-17-run2.json`, `agent-scratch/react-performance/controlled-after-defer-device-refresh-2026-06-17-run3.json`, and `agent-scratch/react-performance/all-flows-final-2026-06-17.json` passed with zero console warnings/errors.
  - Final matrix medians: startup 72 ms, Settings 40 ms, Files 49 ms, Transcriptions 53 ms, Models 33 ms, API Keys 34 ms.
  - `node agent-scratch/react-performance/visual-verify-uttr.mjs` passed for startup/home, Settings, Files, Transcriptions, Models, and API Keys; screenshot saved at `agent-scratch/react-performance/visual-verification-settings.png`.
  - Browser verification passed against `http://127.0.0.1:1420/ux-review.html?state=history` for Settings and API Keys with no framework overlay and zero warning/error logs; screenshots saved outside the repo at `/tmp/uttr-react-performance-settings-2026-06-17.png` and `/tmp/uttr-react-performance-api-keys-2026-06-17.png`.
  - `bun run build` passed.
  - `bun run lint` passed.
  - `bun run test:playwright` passed: 15 tests.
- Protected paths: do not edit `src-tauri/`, package manager files, `dist/`, `node_modules/`, `test-results/`, or `playwright-report/` unless a future measured bottleneck and repo rules make that necessary; do not alter user data or secrets
- Evidence paths:
  - `agent-scratch/react-performance/controlled-before-direct-imports-2026-06-17-run1.json`
  - `agent-scratch/react-performance/controlled-before-direct-imports-2026-06-17-run2.json`
  - `agent-scratch/react-performance/controlled-after-defer-device-refresh-2026-06-17-run2.json`
  - `agent-scratch/react-performance/controlled-after-defer-device-refresh-2026-06-17-run3.json`
  - `agent-scratch/react-performance/all-flows-final-2026-06-17.json`
  - `agent-scratch/react-performance/visual-verification-2026-06-17.json`
  - `agent-scratch/react-performance/visual-verification-settings.png`
  - `tasks/react-performance-budget.md`

## Boundaries

- Keep changes narrowly scoped to measured React/frontend bottlenecks.
- Optimize hard, but stop short of changes whose expected gains are smaller than measurement noise or require risky product, native, dependency, storage, or architecture changes without explicit approval.
- Match the existing Uttr design system, app density, and architecture boundaries.
- Prefer existing scripts, mocks, tests, and Browser/Playwright flows over adding new infrastructure.
- Do not start a normal implementation checklist from this plan. It is intended for an adaptive `/goal` loop.
- Do not use Roughdraft, `rd`, or CriticMarkup unless explicitly requested.

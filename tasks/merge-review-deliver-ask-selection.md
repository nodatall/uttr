# Merge Review: deliver/ask-selection

Goal: Make `deliver/ask-selection` merge-ready by reviewing `origin/main...HEAD`, fixing verified local findings, validating, and rereviewing until no `Disposition: fix` findings remain.

## Branch And Base

- Branch: `deliver/ask-selection`
- Branch slug: `deliver-ask-selection`
- Base: `origin/main`
- Review scope: `origin/main...HEAD`, including current working-tree changes
- Started at: `2026-06-06T03:00:54Z`
- Starting status: original round started clean except for this state document.
- Resumed at: `2026-06-06T05:10:31Z`
- Resumed status: `## deliver/ask-selection` with substantial implementation dirty work from the React Doctor cleanup and current branch review scope. The earlier merge-ready verdict is superseded until Round 3 reviews, validates, and either commits or explicitly classifies the current dirty work.
- Resumed again at: `2026-06-06T15:10:31Z`
- Current status at resume: `## deliver/ask-selection`; no uncommitted working-tree changes before updating this state document. The prior merge-ready verdict is superseded until Round 4 completes a fresh review of the current `origin/main...HEAD`.

## End Condition

The merge-review goal is complete only when:

- A fresh full-branch review of `origin/main...HEAD` finds no remaining `Disposition: fix` findings.
- Every earlier `Disposition: fix` finding is fixed, validated, and marked closed, or reclassified with evidence.
- Remaining findings, if any, are only `needs human decision`, `residual risk`, or `no action`.
- Relevant validation commands pass, or failures are recorded as human-blocked or residual with evidence.
- No uncommitted implementation fixes from the merge-review loop remain. The only allowed dirty file is this state document when the repo treats review artifacts as uncommitted working notes.
- This document's `Resume State` says `Current status: done`.

Do not stop because one round passed after fixes unless that round was a fresh rereview of the latest branch state.

## Round Log

| Round | Scope | Result | Next action |
| --- | --- | --- | --- |
| 1 | `origin/main...HEAD` plus working tree | `AS-1` stale Ask Selection session finding classified `Disposition: fix` | repair and validate |
| 2 | latest `origin/main...HEAD` after `0d292e1` | no remaining `Disposition: fix` findings | done |
| 3 | latest `origin/main...HEAD` plus current working tree after React Doctor cleanup | `RD-1` pending Start state finding classified `Disposition: fix`; rereview after fix found no remaining `Disposition: fix` findings | done |
| 4 | latest `origin/main...HEAD` after `9dda44f` plus current state-doc change | no remaining `Disposition: fix` findings | done |

## Findings

| ID | Round | Severity | Disposition | Scope | Status | Evidence | Fix or reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AS-1 | 1 | P2 | fix | Ask Selection backend session lifecycle | validated | Error paths reused `current_ask_selection_messages()` while `hide_ask_selection_panel` only cleared overlay payload; a previous result could reappear in a fresh failed Ask Selection request. | Added `clear_ask_selection_session()`, clear on new Ask Selection start and panel hide, and added `clear_ask_selection_session_drops_prior_messages`; committed as `0d292e1`. |
| RD-1 | 3 | P2 | fix | Home workspace full-system recording controls | validated | Removing the render-time pending reset made an `idle -> idle` backend fallback leave the Home Start button stuck in disabled `Starting` state; `tests/e2e/full-system-audio.spec.ts` reproduced this failure. | Pending actions are now tagged with the exact `SessionWindowState` object that started them, so any backend session event, including same-stage fallback, invalidates the pending label without copying derived state. |

## Fix Log

| Finding ID | Change | Files | Validation |
| --- | --- | --- | --- |
| AS-1 | Clear backend Ask Selection chat state between request lifecycles and when the panel closes. | `src-tauri/src/actions.rs`, `src-tauri/src/commands/mod.rs` | `cargo test actions::tests::clear_ask_selection_session_drops_prior_messages`; full `cargo test`; UI probe result/follow-up/error states passed. |
| RD-1 | Replace render-time session pending reset with identity-based pending invalidation for the Home workspace controls. | `src/components/workspace/HomeWorkspace.tsx` | Failed Playwright case now passes; full `npm run test:playwright -- tests/e2e/full-system-audio.spec.ts` passes; React Doctor reports no issues; committed in `053c70e`. |

## Validation Log

| Command or flow | Result | Evidence | Remaining gap |
| --- | --- | --- | --- |
| Prime Directive preflight | pass | `/Volumes/Code/primedirective/scripts/prime-directive-codex-preflight.sh` exited 0 | none |
| `git fetch origin` | pass | fetched `origin` and tag `v0.1.12` | none |
| `npm run build` | pass | Vite/TypeScript production build completed; existing chunk-size warning remains | none |
| `npm run lint` | pass | ESLint over `src` completed | none |
| `cargo test` | pass | 230 passed, 1 ignored | none |
| `cargo test actions::tests::clear_ask_selection_session_drops_prior_messages` | pass | regression test for `AS-1` passed | none |
| `cargo test actions::tests::ask_selection` | pass | existing Ask Selection prompt tests passed | none |
| Browser UI check | pass | In-app Browser rendered `http://127.0.0.1:1420/src/ask-selection/index.html` with visible Ask Selection region, Close button, and Thinking loader | none |
| `node agents-scratch/merge-review/ask-selection-ui-probe.mjs` | pass | Captured `ask-selection-thinking.png`, `ask-selection-result-follow-up.png`, and `ask-selection-error.png`; follow-up invoked `ask_selection_follow_up` with `sessionId: 42` | none |
| `npm run test:playwright -- tests/e2e/full-system-audio.spec.ts` | pass | 12 Chromium tests passed | none |
| `node scripts/release-transcribe-smoke.mjs --preflight-only --no-screenshots` | pass | Provider/settings/model preflight passed using isolated app data | Full native smoke was not run because it launches and controls Uttr/TextEdit; see residual risk. |
| `git diff --check origin/main...HEAD` | pass | no whitespace errors | none |
| Fresh rereview | pass | Latest branch after `0d292e1` has no remaining `Disposition: fix` findings | none |
| Round 3 review | pass | Current dirty React Doctor cleanup plus `origin/main...HEAD` reviewed; `RD-1` was the only verified local `Disposition: fix` finding and was repaired | none |
| `npx react-doctor@latest --verbose --no-score` | pass | scanned 227 files; no issues found after `RD-1` fix | score call not part of this command |
| `npx tsc --noEmit` | pass | TypeScript completed after `RD-1` fix | none |
| `npx eslint src` | pass | ESLint over app `src` completed after `RD-1` fix | none |
| `npm --prefix marketing-site run lint` | pass | marketing-site ESLint completed | none |
| `npm run build` | pass | TypeScript and Vite production build completed; existing chunk-size warning remains | none |
| `cargo test` | pass | 231 passed, 1 ignored | existing dead-code warnings remain |
| `npm run test:playwright -- tests/e2e/full-system-audio.spec.ts` | pass | 12 Chromium tests passed after the initial Round 3 failure exposed `RD-1` | none |
| UX review browser sweep | pass | `ux-review.html` states `saved`, `live`, `history`, `missing-summary`, and `idle` rendered on 1280x900 and 390x844 viewports with no console errors and no horizontal overflow | normal `/` browser entry remains Tauri-dependent without mocks |
| `node scripts/release-transcribe-smoke.mjs --preflight-only --no-screenshots` | pass | Provider/settings/model preflight passed using isolated app data | Full native smoke was not run because it launches and controls Uttr/TextEdit; see residual risk. |
| `git diff --check origin/main...HEAD && git diff --check` | pass | no whitespace errors in committed branch diff or working-tree diff | none |
| Round 3 implementation commit | pass | committed validated implementation changes as `053c70e` (`Clean up React surfaces for merge review`) | none |
| Round 3 final git status | pass | `## deliver/ask-selection` with only the merge-review state document dirty at that time | superseded by Round 4 final status |
| Prime Directive preflight | pass | `/Volumes/Code/primedirective/scripts/prime-directive-codex-preflight.sh` exited 0 for Round 4 | none |
| `git fetch origin --prune` | pass | confirmed remote default branch `main`; pruned deleted remote branch ref | none |
| `npm run build` | pass | TypeScript and Vite production build completed; existing chunk-size warning remains | none |
| `npm run lint` | pass | ESLint over `src` completed | none |
| `cargo test` | pass | 246 passed, 1 ignored; existing dead-code warnings remain | none |
| `npm --prefix marketing-site run lint` | pass | marketing-site ESLint completed | none |
| `npm --prefix marketing-site test` | pass | 118 Bun tests passed | none |
| `npm run test:playwright -- tests/e2e/full-system-audio.spec.ts` | pass | 12 Chromium tests passed | none |
| Ask Selection shimmed UI probe | pass | `node agents-scratch/merge-review/ask-selection-ui-probe.mjs` verified thinking, follow-up command with `sessionId: 42`, and error states; refreshed `agents-scratch/merge-review/output/ask-selection-*.png` | none |
| UX review browser sweep | pass | `saved`, `live`, `history`, `missing-summary`, and `idle` states rendered at 1280x900 with no page errors and no horizontal overflow; saved state also rendered at 390x844; screenshots in `agents-scratch/merge-review/round4-ux-*.png` | none |
| `node scripts/release-transcribe-smoke.mjs --preflight-only --no-screenshots` | pass | Provider/settings/model preflight passed using isolated app data | Full native smoke was not run because it launches and controls Uttr/TextEdit; see residual risk. |
| `git diff --check origin/main...HEAD && git diff --check` | pass | no whitespace errors in committed branch diff or working-tree state-doc diff | none |
| Round 4 rereview | pass | Bounded `bug_prior` checked Ask Selection promotion/cancel generation, provider fallback, selected-text fallback, modifier-only event ordering, marketing access/auth refactors, and UI surfaces; no verified local fix finding survived. `smaller_delta` found no safe reduction that lowers merge risk. `skeptic_falsifier` rejected standalone-browser Tauri bridge errors as a non-production probe limitation after the shimmed UI probe passed. | none |

## Remaining Human Decisions

- None currently.

## Residual Risks

- Full native `scripts/release-transcribe-smoke.mjs` was not run. The preflight passed, and the changed script path was reviewed, but the full flow is invasive desktop automation that launches Uttr and TextEdit.
- The plain `/` browser entry is Tauri-dependent and can throw without mocked Tauri globals; Round 3 used `ux-review.html` with repo mocks for browser-level evidence.
- Directly opening `src/ask-selection/index.html` in a plain browser without a Tauri shim throws bridge errors from `@tauri-apps/api/event`; the actual app runs inside Tauri, and Round 4 verified the panel through the shimmed Ask Selection probe.

## Resume State

- Current status: done
- Current phase: complete
- Last completed step: completed Round 4 fresh review and validation over latest `origin/main...HEAD`
- Active step: none
- Next exact action: none
- Blockers: none
- Last validation: `npm run build`, `npm run lint`, `cargo test`, `npm --prefix marketing-site run lint`, `npm --prefix marketing-site test`, full-system Playwright spec, Ask Selection shimmed UI probe, UX review browser sweep, release smoke preflight, and `git diff --check` passed in Round 4
- Protected paths: implementation fixes committed in `0d292e1`, `053c70e`, and `9dda44f`; only this tracked state document remains dirty from Round 4
- Evidence paths: `tasks/merge-review-deliver-ask-selection.md`; `agents-scratch/merge-review/round4-ux-*.png`; `agents-scratch/merge-review/output/ask-selection-*.png`

## Final Merge-Readiness Verdict

- Verdict: merge-ready under `$merge-review`
- Reason: all verified `Disposition: fix` findings (`AS-1`, `RD-1`) were fixed, validated, committed, and rereviewed. Round 4 found no new `Disposition: fix` findings over the latest branch. Final status has no uncommitted implementation changes; only this tracked review artifact is dirty from the current merge-review update.

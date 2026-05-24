# Agents

Primary workflow lives in the installed Prime Directive skills, not in a checked-in repo-local `skills/` mirror.

## Skill Router

Use these skills for workflow triggers:

- `$deliver`
- `$review-chain`
- `$repo-sweep`
- `$cleanup-merged-branches`
- `$first-principles-mode`
- `$bootstrap-repo-rules`

Trigger mapping:

- `$deliver [--pro-analysis]`
- `$review-chain [--preserve-review-artifacts]`
- `$repo-sweep [--pro-analysis] [--swarm] [--dep-scan] [--preserve-review-artifacts]`
- `$cleanup-merged-branches [<branch-name>]`
- `$first-principles-mode "..." [--pro-analysis]`
- `$bootstrap-repo-rules [--with-hooks]`

Planning defaults:

- Planning treats user input as source-plan material to improve and normalize.
- `--deep-research` runs a substantial staged research pass focused on technical design, rollout/migration, security/ops, and verification strategy after initial PRD/TDD drafting and before task generation; it is not satisfied by a token search burst.
- `--deep-research` must be anchored to the exact current date, scoped to the plan's actual stack and constraints, and backed by current external primary sources with freshness notes.
- `--deep-research` must produce plan-specific implementation guidance in addition to improving the current PRD/TDD.
- `--preserve-planning-artifacts` keeps temporary planning research artifacts under `tasks/tmp/`.
- Planning always outputs:
  - `tasks/prd-<plan-key>.md`
  - `tasks/tdd-<plan-key>.md`
  - `tasks/tasks-plan-<plan-key>.md`
- Socratic flow is conversational: one question per turn, plain language, targeted gap-checking.
- Before drafting PRD, TDD, or tasks-plan, planning must present a separate plain-language checkpoint in exactly three short paragraphs and give the user a chance to correct it.
- Final planning artifacts must not contain `Open questions` or `Open technical questions`.
- Plain-language summaries are required in the Socratic flow, PRD, and TDD.

Execution behavior:

- Use `$deliver` for Prime Directive planning and execution.
- Use `$review-chain` for explicit review runs.
- Use `$repo-sweep` for full-repository sweeps. In `/goal $repo-sweep`, the goal invocation authorizes the bounded repair/resweep loop after the Round 1 report is recorded.

## Repo-Specific Norms

- Branch naming: `<short-task-name>` (concise, concrete).
- After a feature branch is confirmed merged into `origin/main`, delete it locally and on `origin` when safe. Use `clean up merged branches [<branch-name>]` for this. Never delete `main`, the currently checked out branch, a branch with unmerged local commits, or a branch tied to an open PR.
- Update `tasks/tasks-plan-<plan-key>.md` after each completed sub-task in task-mode execution.
- For ad-hoc work outside the explicit workflow commands above, task-list updates are not required unless explicitly requested.
- For ad-hoc code changes, follow existing local implementation and test patterns before introducing a new pattern.
- For ad-hoc code changes, inspect the repo's actual validation surface first: manifests, scripts or task runners, CI workflows, lint or format configs, typecheck or build configs, and any git hook setup.
- For ad-hoc code changes, prefer the fastest meaningful verification for the exact slice being changed.
- For ad-hoc code changes, when the repo already defines relevant lint, format-check, typecheck, test, or build commands for the touched surface, run them before handoff instead of relying only on spot checks.
- If a repo has no meaningful validation surface for its stack and the user wants first-time setup, use `bootstrap repo rules [--with-hooks]` before relying on lint, format-check, typecheck, test, or build commands that do not exist yet.
- For ad-hoc changes that are practically testable with a targeted unit, component, or narrow integration test, prefer a failing test first before implementing the change.
- For ad-hoc frontend work, do not default to broad browser or E2E runs during normal iteration; use them only when the change touches a user-critical flow that cannot be validated well with cheaper checks, when the relevant files or repo norms already require them, or when the user explicitly asks for them.
- If a failing-test-first loop is not practical for an ad-hoc change, say why briefly and run the best relevant verification instead.
- Update `README.md` only when setup/commands/env requirements change.
- Tests: prefer `npm test`; if skipped, say why.
- Bugs: add regression test when it fits.
- When working on browser E2E tests (especially files under `tests/e2e/**`, `playwright.config.*`, or Playwright CI scripts), use the `playwright` skill by default.

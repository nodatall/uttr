# Simplify Uttr without changing behavior

Goal: Reduce the code we maintain by deleting unreachable code and obsolete interfaces while preserving every supported user flow and meaningful regression check.

Implementation authorization: The user explicitly asked to make behavior-preserving changes after the audit. Keep the scope limited to the verified deletions below.

Deliver implementation instruction:
When asked to implement this doc, load the `$deliver` skill, use this file as the approved execution plan, scan every checkbox, and continue through final review, archive movement, commit, and finalization before the final handoff.

## Context

- The starting checkout is clean. Work stays on `deliver/codebase-simplification`.
- A previous commit already consolidated tests. Test count and line count are evidence, not targets that justify losing coverage or making code denser.
- Keep cancellation, microphone recovery, shortcut ordering, history persistence, provider fallbacks, payment, authorization, privacy, and rate-limit behavior intact.
- Keep the CI transcription mock, browser mocks, release checks, existing product surfaces, persisted settings, and generated bindings.
- Runtime boundaries and rendered design stay the same. Remove only unused members inside those boundaries and unreachable files.

## Steps

### 1. Delete unreachable native code

- [x] Delete the unregistered recorder CLI, unused cursor helper, unused access-message accessor, obsolete transcription wrappers, and unused mixed-audio delta wrapper. Align the corresponding CI mock methods with the remaining interface.
- [ ] Verify Rust tests, the native build, and release-transcription preflight. Run the full isolated transcription smoke when local permissions allow it and report any exact blocker. Preserve all native regression tests.

### 2. Remove unused frontend state and helpers

- [x] Delete unused date-only and relative-time formatting code while preserving `formatDateTime` output and fallbacks.
- [x] Trim the post-processing hook to the model controls its caller actually uses, retaining provider selection effects, filtering, refresh, and automatic fetching.
- [x] Delete unconsumed store getters/setters, obsolete download-selection and first-run bookkeeping, and unreachable settings export files. Preserve model loading, selection, background prefetch, and event handling.
- [x] Verify build, lint, existing browser tests, and focused comparisons of date formatting, model lifecycle, and post-processing controls. Capture browser evidence for the affected settings flow.

### 3. Remove obsolete backend code and its test

- [ ] Delete the uncalled premium-source classifier and the test that only exercises it, retaining live access-policy coverage. Delete the ignored provider MIME argument and its type field.
- [ ] Run the complete backend test runner, lint, and build; confirm live access checks and upload validation remain unchanged.

### 4. Challenge the result and finish

- [ ] Review the entire diff for changed behavior, unsupported reachability assumptions, unnecessary additions, and lost test coverage. Repair verified in-scope findings and rerun affected checks.
- [ ] Record the actual line reduction and validation limits, archive this plan, commit the scoped changes, and verify the final working tree.

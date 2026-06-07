# Incremental Finalization

Goal: Keep long dictations from throwing away completed incremental transcription chunks.

Deliver implementation instruction:
When asked to implement this doc, load the `$deliver` skill, use this file as the approved execution plan, scan every checkbox, and continue through final review, archive movement, commit, and finalization before the final handoff.

## What We Know

- Long dictations can complete several incremental chunks before release.
- The previous finalization wrapper could time out and fall back to a duplicate full-pass request.
- Completed incremental text should be preferred over no transcript or an avoidable full-pass retry once at least two chunks are complete.

## Steps

### 1. Preserve completed chunk progress

- [x] Add chunk-aware finalization timing for incremental transcription.
- [x] Return assembled completed chunks when the incremental tail fails after enough progress.
- [x] Prevent the outer timeout wrapper from discarding completed chunks after enough incremental progress.

### 2. Improve diagnosis

- [x] Log completed chunk count, next chunk start, full sample count, tail sample count, and completed-chunk fallback reason.

### 3. Verify the behavior

- [x] Add focused regression coverage for the timeout and full-pass retry decision.
- [x] Update regression coverage so it catches the completed-chunks timeout path.
- [x] Run targeted Rust tests.
- [x] Run the full Rust test suite.
- [x] Run the native Tauri build check or document the exact local blocker.
- [x] Run the release transcription smoke preflight.

### 4. Close out through Deliver

- [x] Run final full-branch review against this execution plan.
- [x] Fix any in-scope material findings and rerun relevant checks.
- [x] Archive this execution plan.

Commit and finalization gate evidence are recorded in the final handoff.

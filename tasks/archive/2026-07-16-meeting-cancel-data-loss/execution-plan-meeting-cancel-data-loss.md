# Prevent Escape From Discarding Meetings

Goal: Keep full-system meetings recording until the user clicks Stop, while preserving Escape cancellation for standalone and meeting-time quick dictation.

Fast mode note: Initial plan-review pause skipped by `--fast`; continue into implementation after refinement unless a fast-mode stop condition applies.

Deliver implementation instruction:
When asked to implement this doc, load the `$deliver` skill, use this file as the approved execution plan, scan every checkbox, and continue through final review, archive movement, commit, and finalization before the final handoff.

## Context

- Full-system meetings currently register the global Escape cancellation shortcut.
- The generic cancellation path discards full-system capture and bypasses live-session finalization and history persistence.
- Escape and repeated meeting-hotkey input must not stop or cancel a meeting. The meeting Stop button is the only normal stop path.
- Escape should continue to cancel standalone dictation and should cancel only the nested quick dictation when one is active during a meeting.
- No visible UI change is required.

## Steps

### 1. Enforce the meeting cancellation policy

- [x] Add an explicit coordinator command for the UI Stop action. Repeated meeting-shortcut inputs are ignored. UI Stop must finalize exactly once from every meeting state: no quick dictation, quick dictation recording, or quick dictation processing. When quick dictation is active, finish its microphone borrow safely, wait for any required processing, and then finalize and save the meeting.
- [x] Ensure meeting-only recording state has no dynamic Escape binding, including after quick dictation returns to the meeting.
- [x] Route cancellation by both source and coordinator stage before any mutation. User Escape is a complete no-op during meeting-only recording. Preserve file-transcription cancellation. Preserve both watchdog paths explicitly: transcription-task watchdogs cancel only their associated task, and coordinator stale-processing recovery cannot discard captured meeting data or permit a second meeting to start while finalization remains active.
- [x] During standalone or nested quick dictation, Escape cancels only that dictation in both Recording and Processing states. Nested cancellation must be task-scoped: it must not set meeting-wide transcription cancellation state, and it must restore the meeting without changing its capture, live transcription, tray, overlay, or coordinator state.

### 2. Add regression coverage

- [x] Add focused tests proving meeting start and return from quick dictation leave Escape unregistered, meeting-only Escape has no meeting side effects, and file-transcription, standalone-dictation, nested-dictation, transcription-task-watchdog, and meeting-finalization-watchdog cancellation each reach only their intended target.
- [x] Add coordinator tests proving Escape cancels only nested or standalone dictation in both recording and processing, repeated meeting-hotkey input cannot stop a meeting, and the explicit UI Stop command finalizes once with no quick dictation, quick dictation recording, or quick dictation processing. Repeated UI Stop commands and racing quick-dictation or meeting `ProcessingFinished` events must call the full-system stop action and history save exactly once.
- [x] Verify Escape neither finalizes nor creates meeting history, while UI Stop follows the existing one-entry finalization and save path.
- [x] Verify nested Escape produces no quick-dictation paste or history entry, and a meeting chunk recorded afterward is transcribed and included in the saved raw transcript.
- [x] Run targeted policy and coordinator tests, `cd src-tauri && cargo test`, `cargo fmt --check`, `bun run test:e2e:release-transcribe -- --preflight-only`, and `bun run tauri:build:fast`.
- [x] Reproduce the native core flow: start from the UI, press Escape and confirm recording continues, click Stop, and verify one saved raw transcript and no meeting-cancellation log. The automation driver cannot synthesize macOS `fn`, so nested-dictation cancellation and repeated `ctrl+fn` meeting-hotkey behavior are verified by production-routing and coordinator tests rather than the native driver.

### 3. Review and close out

- [x] Review the full branch diff against this plan and resolve every material finding.
- [x] Archive this execution plan and complete the finalization checks.

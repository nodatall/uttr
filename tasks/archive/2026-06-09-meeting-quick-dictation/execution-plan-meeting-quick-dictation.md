# Meeting Quick Dictation

Goal: Allow normal dictation while a full-system meeting recording continues.

Please review this before I start.
Tell me what is wrong, missing, or out of order.

Deliver implementation instruction:
When asked to implement this doc, load the `$deliver` skill, use this file as the approved execution plan, scan every checkbox, and continue through final review, archive movement, commit, and finalization before the final handoff.

## What We Know

- The coordinator currently tracks one global transcription stage.
- The current `Stage::Recording(String)` / `Stage::Processing` flow cannot represent "meeting active plus quick dictation active."
- Full-system meeting recording owns the meeting session and may include microphone plus system audio.
- The microphone recording manager can record only one binding at a time, but it can transfer the active binding.
- Transferring the active microphone binding only changes the label; it does not create a sample boundary or drain old meeting samples.
- The easiest version should keep the meeting session alive and let quick dictation run as a separate short action.
- This plan does not add microphone fanout. Quick dictation may borrow the meeting microphone stream briefly, so the meeting may miss local microphone audio during that short interval while system audio continues.
- Quick dictation completion must restore coordinator, UI, tray, and cancel state back to "meeting active."
- No frontend layout or styling change is planned.

## Steps

### 1. Separate The Coordinator State

- [x] Add an explicit coordinator state for this case, for example `MeetingRecording { binding_id, quick_dictation: Option<...> }`.
- [x] Let the coordinator keep `transcribe_full_system_audio` as the main recording stage while a normal `transcribe` push-to-talk action runs beside it.
- [x] Track the quick dictation binding separately from the meeting stage so its release stops only the quick dictation.
- [x] Prevent quick dictation stop from setting global processing/finished state that resets the meeting to idle.
- [x] Keep existing single-session behavior for normal dictation, Ask Selection, and full-system start/stop outside this specific meeting-plus-dictation case.

### 2. Keep Audio Ownership Simple

- [x] Add a narrow audio manager/helper contract for meeting mic borrow: drain meeting mic samples, start a quick-dictation sample boundary, stop quick dictation, then restore or restart the meeting mic binding.
- [x] Start quick dictation by borrowing the active meeting microphone recording into a distinct internal quick-dictation binding when the meeting microphone is active.
- [x] If the meeting has no active microphone source, start quick dictation with the normal microphone recording path while the meeting keeps system audio capture active.
- [x] On quick dictation stop, collect only post-boundary quick-dictation samples and then return microphone ownership to the meeting binding when the meeting is still active.
- [x] Keep the full-system session snapshot consistent with the restored microphone source after quick dictation.
- [x] Make quick dictation stop route through normal transcription finalization and paste, not through full-system session completion.

### 3. Keep Meeting UI And Lifecycle Intact

- [x] Prevent quick dictation completion from marking the meeting window complete or stopping the meeting live summary/session state.
- [x] Keep meeting live system-audio chunking active while quick dictation borrows or uses the microphone path.
- [x] Keep the full-system stop shortcut able to stop the meeting after one or more quick dictations.
- [x] After quick dictation paste, restore meeting-visible overlay/tray state instead of leaving the app idle.
- [x] After quick dictation stop, restore meeting cancel/stop shortcut ownership.

### 4. Add Focused Regression Tests

- [x] Add coordinator tests for starting normal dictation while full-system recording is active.
- [x] Add coordinator tests that releasing normal dictation leaves the full-system meeting stage active.
- [x] Add a coordinator test proving one full-system shortcut press stops the meeting after quick dictation finishes.
- [x] Add audio-manager tests proving quick dictation samples exclude pre-borrow meeting mic audio.
- [x] Add or update action/manager tests for mic borrow, restore, tray/overlay restore, and cancel ownership.

### 5. Validate

- [x] Run targeted Rust tests for the coordinator and any changed action/manager modules.
- [x] Run `cd src-tauri && cargo test`.
- [x] Run `PATH="$HOME/.bun/bin:$PATH" bun run test:e2e:release-transcribe -- --preflight-only`.
- [x] Attempt `PATH="$HOME/.bun/bin:$PATH" bun run tauri:build:fast`; blocked before build by missing updater signing key config.
- [x] Manual native smoke was not practical in this run because the native build gate is blocked by missing updater signing key config.

# Release Transcribe Smoke Test

Goal: Add a local release command that runs a real end-to-end Uttr transcription smoke test before it triggers the existing GitHub release workflow.

Please review this in Roughdraft before I start. Tell me what is wrong, missing, or out of order.

Deliver implementation instruction: When asked to implement this doc, load the `$deliver` skill, use this file as the approved execution plan, scan every checkbox, and continue through final review, archive movement, commit, and finalization before the final handoff.

## What We Know

- The current Playwright suite runs against the Vite UI and mocks Tauri calls. It does not prove global shortcuts, native overlays, live microphone capture, transcription, or paste into another app.
- The current release workflow is triggered through GitHub Actions and builds/publishes the app from `.github/workflows/release.yml`.
- The native smoke test should run locally before release. It should not depend on GitHub-hosted macOS Accessibility automation.
- The smoke test should use the live microphone and the real transcription path. It should not replace transcription with a deterministic fake transcript.

## Steps

### 1. Define the local release smoke contract

Goal: Make the test prove the real user flow without adding a new permission requirement for normal Uttr users.

- [x] Keep the shortcut, live microphone recording, recording animation, recording stop, transcription, output finalization, and paste path real.

- [x] Isolate test settings and app data so the smoke test cannot read, migrate, overwrite, or expose a user's normal Uttr settings or BYOK secrets.

- [x] Make the smoke test verify that a real transcription model or provider is available in the isolated profile before recording starts.

- [x] Decide the safest local test shortcut and push-to-talk setting for automation, then make the smoke test set those values explicitly.

- [x] Make the smoke test use a known spoken phrase and assert that the pasted result contains enough of that phrase to prove transcription worked.

### 2. Build the local macOS smoke runner

Goal: Create one local command that runs the native flow end to end on the release machine.

- [x] Add a smoke script that starts Uttr with isolated app data, opens a focused text target, triggers the configured shortcut, records from the live microphone, stops recording, and waits for pasted text.

- [x] Include an operator-friendly prompt or audio cue for the known spoken phrase so the local release run is repeatable.

- [x] Verify the recording animation path with app logs or a captured visual signal, not only the final pasted text.

- [x] Fail with a clear message when local automation permission, app startup, shortcut delivery, overlay feedback, microphone capture, transcription model availability, transcription, or paste does not work.

- [x] Save useful failure evidence under an ignored scratch or artifact path so release failures can be diagnosed quickly.

### 3. Add the local release command

Goal: Make the release path run the smoke test first, then trigger the existing GitHub release workflow.

- [x] Add a package script or repo script for the native release smoke test.

- [x] Add a local release command that runs the native smoke test and only then runs `gh workflow run release.yml --ref main`.

- [x] Make the local release command verify it is safe to trigger a release from `main`, including the expected version files and git state.

- [x] Keep `.github/workflows/release.yml` as the remote build and publish workflow, but do not pretend it ran the native local smoke test itself.

- [x] Keep the existing browser Playwright tests as PR coverage, but do not treat them as proof of native shortcut, overlay, microphone, transcription, or paste behavior.

### 4. Validate and close out

- [x] Run focused backend tests for any settings isolation or smoke-test support logic.

- [x] Run the native smoke command locally when the environment supports it, or record the exact local permission or setup requirement if it cannot run here.

- [x] Run formatting or syntax checks for any changed scripts, workflows, and Rust code.

- [x] Run a final review against this plan and fix any in-scope findings before archiving the plan.

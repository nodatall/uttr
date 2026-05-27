# Hotkey Start Latency Fix

Goal: Make push-to-talk recording start promptly, and make delayed starts fail harmlessly instead of producing empty transcriptions.

Please review this before I start.
Tell me what is wrong, missing, or out of order.

Deliver implementation instruction:
When asked to implement this doc, load the `$deliver` skill, use this file as the approved execution plan, scan every checkbox, and continue through final review, archive movement, commit, and finalization before the final handoff.

## What We Know

- The hotkey was registered and fired.
- The failed run received `fn` press at 21:42:50 and `fn` release at 21:42:51.
- Recording did not become active until 21:42:56.
- Push-to-talk then stopped after about 57ms, and the near-silent Groq result was suppressed.
- The next starts were normal at 43ms and 37ms, so this is intermittent.
- The delay appears before audio startup, between adjacent start-path logs.
- HandyKeys is currently restarted by a backend heartbeat every 3 minutes.

## Steps

### 1. Protect the start path

- [x] Move or remove synchronous hot-path logging that runs before recording starts.
- [x] Keep enough latency evidence to diagnose future slow starts, but emit it after recording is active or only when a slow-start threshold is crossed.
- [x] Include the coordinator's pre-action latency logs in this cleanup, because those also run before audio is active.
- [x] Preserve existing normal recording behavior for microphone, edit mode, and post-processing bindings.

### 2. Make push-to-talk robust to delayed starts

- [x] Carry input receive timestamps through coordinator commands so delayed ordering can be detected after a synchronous start returns.
- [x] If push-to-talk release was received before recording became active, stop without sending the tiny silent clip to transcription.
- [x] Keep normal short utterances working when recording really was active before the release.
- [x] Add focused Rust tests for the delayed-press/release ordering.

### 3. Stop disruptive shortcut refresh churn

- [x] Remove the 3-minute backend HandyKeys restart heartbeat or replace it with a less invasive event-driven repair path that does not restart listeners while idle hotkeys are expected.
- [x] Keep shortcut refresh on app resume, settings changes, and explicit repair paths.
- [x] Keep active-recording protection around any remaining shortcut refresh path.

### 4. Validate the fix

- [x] Run targeted Rust tests for transcription coordination and shortcut behavior.
- [x] Run formatting checks for changed Rust files.
- [x] Inspect fresh local logs from a manual hotkey attempt and confirm the sequence reaches recording promptly or cancels cleanly if release wins.

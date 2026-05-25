# Open Uttr Workspace

This is a draft Deliver plan.
It is not approved for implementation yet.

Draft discussion instruction:
When asked to keep discussing or update this doc, load the `$deliver` skill and update this file as the current draft plan.
When asked to turn this into a deliver plan, load the `$deliver` skill, rewrite this same file into the normal checklist execution-plan shape, replace this instruction with the Deliver implementation instruction, refine the plan, and ask for review before implementation.

## Phase 1 - Product Shape

- [ ] Treat the tray action as `Open Uttr`, not `Open Settings`.
- [ ] Keep quick dictation as the small push-to-talk overlay and paste flow. This path should stay fast, quiet, and out of the Dock unless the user opens a real window.
- [ ] Make the opened Uttr window a normal app workspace with utility screens, not a settings-only window and not a separate meeting app.
- [ ] Use the balsamiq-style HTML mockup at [tasks/mockups/session-window-balsamiq.html](mockups/session-window-balsamiq.html) only as a rough flow and information-architecture sketch for Home, Files, History, Sessions, Dictations, and Settings.
- [ ] Build the real UI from [docs/DESIGN.md](../docs/DESIGN.md), using Uttr's dark neutral design system, compact utility layout, existing components, and production visual tokens.
- [ ] Do not copy the mockup's Balsamiq visual style, hand-drawn typography, light paper background, thick borders, or oversized sketch controls into the production app.

## Phase 2 - Navigation

- [ ] Use `Home`, `Files`, `History`, and `Settings` as the main window destinations.
- [ ] Let `Home` become the live session workspace when full-system recording is active.
- [ ] When no full-system recording is active, let `Home` be a simple launch/recent-state surface rather than a permanent meeting page.
- [ ] Keep `Settings` for configuration only: model, language, hotkeys, storage, privacy, and provider choices.

## Phase 3 - Files

- [ ] Keep file transcription in its own Files page.
- [ ] Make Files feel like a one-off utility: choose one audio file, drag and drop one file, transcribe it, inspect the summary, and optionally view raw transcript.
- [ ] Do not add imported files to the normal transcription history unless the product explicitly changes that rule later.

## Phase 4 - History

- [ ] Split History into `Dictations` and `Sessions`.
- [ ] `Dictations` should contain normal quick transcriptions from the hotkey flow.
- [ ] `Sessions` should contain long full-system recordings with summaries, raw transcripts, context, and session metadata.
- [ ] Keep this split inside the History screen for now instead of promoting both items to the main sidebar.

## Phase 5 - Full-System Sessions

- [ ] When the user starts full-system recording, open or focus Uttr and show the live session workspace on Home.
- [ ] Make it obvious that the app is capturing system audio and microphone audio.
- [ ] Keep the compact overlay as supporting status UI, not the primary full-system recording surface.
- [ ] Make Dock behavior mode-aware. Background dictation can keep Uttr as a tray-style accessory app, but opening Uttr for files, history, settings, or a live session should make it a normal Dock-visible app.

## Phase 6 - Home Session Controls

- [x] Add a `Stop` button to the Home live-session state.
- [x] Keep `Start` available only when no full-system session is active.
- [x] Route `Stop` through the same full-system recording coordinator as the existing full-system shortcut stop path.
- [x] Keep the compact overlay as a supporting status surface while Home remains the primary live-session surface.
- [x] Remove the legacy full-system processing overlay from the Stop path.
- [x] Show clear live states on Home: recording, stopping, transcribing chunk, summarizing, and saved.

## Phase 7 - Ten-Second Audio Chunks

- [x] For full-system recording, transcribe while recording instead of waiting until the end.
- [x] Use completed 10-second chunks as the first live unit. Do not implement partial-token streaming yet.
- [ ] Capture each chunk with a stable chunk ID, session ID, source time range, provider/model, status, retry count, transcript text, and error text.
- [ ] Keep chunk transcription independent from final session save so one failed chunk can retry without losing the session.
- [x] Preserve chunk order and assemble the displayed transcript from ordered chunk records.
- [x] On stop, flush the final partial chunk, wait for any in-flight chunk work, then save the complete session.

## Phase 8 - Live Summary Updates

- [x] Use OpenAI for session summaries for now.
- [x] Prefer the user's OpenAI BYOK key when one is configured and valid.
- [x] If there is no usable OpenAI BYOK key, show an explicit summary-unavailable state instead of silently sending transcript text through another provider.
- [x] Update the Home summary after each completed transcript chunk, with the first summary usually appearing after the first 10-second chunk finishes transcribing and summarizing.
- [x] Send only transcript text and minimal session metadata to OpenAI for the summary pass.
- [x] Keep the summary incremental: each update should revise the existing summary, action items, and notable points from the transcript so far.
- [x] Keep saved-session summary text separate from raw transcript text, with raw transcript available through an explicit modal.
- [ ] Record which provider/model produced each summary update.

## Phase 9 - Session Storage

- [ ] Save the final session with raw transcript, latest summary, chunks, provider/model metadata, start time, end time, and duration.
- [ ] Keep `History > Sessions` focused on the summary first, with raw transcript available through an explicit detail view.
- [ ] Make failed or partial sessions recoverable enough to inspect what was captured and what failed.
- [ ] Keep imported file transcription out of normal dictation/session history unless the product explicitly changes that rule later.

## Phase 10 - Validation

- [ ] Add focused backend tests for chunk creation, chunk ordering, stop flush, retry handling, and final session save.
- [ ] Add focused frontend tests that Start begins a live session, Stop ends it, and Home updates as chunks and summaries arrive.
- [ ] Add a provider test seam for OpenAI summary requests so BYOK selection and no-key behavior are deterministic.
- [ ] Run the real changed paths: frontend build/lint/Playwright, Rust tests, translation checks, and a rendered Home screenshot for idle, live, and stopped states.

Please review this before I refine it.

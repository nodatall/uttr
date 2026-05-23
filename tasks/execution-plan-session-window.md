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

## Phase 6 - Chunking And Summary

- [ ] For full-system recording, transcribe while recording instead of waiting until the end. Start with completed audio chunks, not true partial-token streaming.
- [ ] Use about 10-second chunks as the first target. Five seconds may feel more live, but it increases provider overhead and makes boundary errors more likely.
- [ ] Track every chunk with an explicit ID, audio time range, provider/model, status, retry count, and transcript text.
- [ ] Preserve chunk boundaries internally and assemble displayed transcript from ordered chunk records.
- [ ] Show summary first for sessions. Raw transcript should be available through an explicit button or detail view.

## Phase 7 - Cloud Analysis And Storage

- [ ] Cloud analysis means sending transcript text or meeting context to a remote LLM provider for summarizing, action items, question suggestions, or meeting coaching.
- [ ] Make cloud sharing explicit because transcript text and meeting context can be sensitive even if raw audio stays local.
- [ ] Meeting context can come later, with a clear rule for what context is sent to cloud models.
- [ ] Session storage should be explicit. The user should be able to see recent sessions, delete them, and understand whether audio, transcript text, and summaries are kept locally.
- [ ] Settings should include a meeting save location control so users can choose where recordings, transcripts, and summaries are stored.
- [ ] Open question: should meeting context be local-only until the user explicitly enables cloud analysis?

Please review this before I refine it.

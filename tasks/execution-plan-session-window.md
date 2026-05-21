# Session Window

This is a draft Deliver plan.
It is not approved for implementation yet.

Draft discussion instruction:
When asked to keep discussing or update this doc, load the `$deliver` skill and update this file as the current draft plan.
When asked to turn this into a deliver plan, load the `$deliver` skill, rewrite this same file into the normal checklist execution-plan shape, replace this instruction with the Deliver implementation instruction, refine the plan, and ask for review before implementation.

- Keep quick dictation as the small push-to-talk overlay and paste flow. This path should stay fast, quiet, and out of the Dock unless the user opens a real window.

- Add a first-class session window for longer work. This window is for full-system recording, summary-first session review, progress, history, and later meeting intelligence.

- Use the balsamiq-style HTML mockup at [tasks/mockups/session-window-balsamiq.html](mockups/session-window-balsamiq.html) as the current visual reference while discussing the session window, Files page, History page, and Settings page.

- When the user starts full-system recording, open or focus the session window instead of only showing the bottom recording overlay. The window should make it obvious that the app is capturing system audio and microphone audio.

- Keep file transcription in its own Files page. The session window should focus on the live full-system session experience.

- Make Dock behavior mode-aware. Background dictation can keep Uttr as a tray-style accessory app, but opening settings or the session window should make Uttr a normal Dock-visible app so users can switch back to it during a meeting.

- For full-system recording, transcribe while recording instead of waiting until the end. Start with completed audio chunks, not true partial-token streaming.

- Use about 10-second chunks as the first target. Five seconds may feel more live, but it increases provider overhead and makes boundary errors more likely. We should only go shorter if the measured latency improvement is worth it.

- Track every chunk with an explicit ID, audio time range, provider/model, status, retry count, and transcript text. The session view should be able to show pending, transcribing, failed, and completed chunks without corrupting the assembled transcript.

- Avoid fragile text stitching at chunk boundaries. The current long-transcription bug reports make it clear that duplicated or scrambled boundary text is a real risk. The new path should preserve chunk boundaries internally and assemble the displayed transcript from ordered chunk records.

- Summaries should be on by default for session recordings and should be the main view in the session window. They should consume completed transcript chunks, not raw audio. That keeps the first version simpler and makes it easier to retry or re-run summaries without touching audio capture.

- The raw live transcript should not be shown by default. It should be available when the user explicitly asks to inspect it, likely through a modal or detail view.

- The first assistant features should be rolling summary, decisions, action items, and questions to ask.

- Cloud analysis means sending transcript text or meeting context to a remote LLM provider for summarizing, action items, question suggestions, or meeting coaching. The plan should be explicit about what gets sent, because transcript text and meeting context can be sensitive even if raw audio stays local.

- Meeting context can come later, with a clear rule for what context is sent to cloud models.

- Meeting context should open from an `Add context` button next to `View raw transcript`, not sit permanently in the main summary view.

- Session storage should be explicit. The user should be able to see recent sessions, delete them, and understand whether audio, transcript text, and summaries are kept locally.

- Settings should include a meeting save location control so users can choose where recordings, transcripts, and summaries are stored.

- Open question: should meeting context be local-only until the user explicitly enables cloud analysis?

- Full-system capture should use the session window by default for every recording. A compact overlay can still exist as supporting status UI, but it should not be the primary full-system recording surface.

# Meeting Source-Labeled Raw Transcript

Goal: In meeting mode, make the raw transcript distinguish local microphone speech from captured system audio as `Me` and `Them`.

Please review this before I start.
Tell me what is wrong, missing, or out of order.

Deliver implementation instruction:
When asked to implement this doc, load the `$deliver` skill, use this file as the approved execution plan, scan every checkbox, and continue through final review, archive movement, commit, and finalization before the final handoff.

## What We Know

- Meeting mode already captures microphone audio and system audio separately, but it mixes them before transcription.
- The live meeting runtime stores one plain `transcript_text` string and one mixed `recorded_samples` buffer.
- History already stores the raw transcript in `transcription_text` and the summary in `post_processed_text`.
- The current session workspace shows the summary first and opens raw transcript only from the existing `Raw transcript` button.
- The labels in this plan are source labels. `Me` means local microphone audio. `Them` means system audio. This is not individual-speaker diarization.
- Separate source transcription can increase provider calls, so the implementation needs quiet-source gating and timing evidence.

Visual mockup: [ui-mockup-meeting-source-labeled-raw-transcript.html](ui-mockup-meeting-source-labeled-raw-transcript.html)

## Steps

### 1. Preserve the audio source through meeting chunks

Goal: Stop losing the mic/system distinction before the transcription step.

- [x] Add a small source-aware meeting audio shape for microphone chunks and system-audio chunks.
- [x] Change meeting live chunk draining so it can return separate source buffers while keeping the existing mixed-audio path available for saved audio playback.
- [x] Change meeting stop handling so the final tail can carry separate microphone and system-audio buffers into the live finalization path.
- [x] Add quiet-source gating before provider calls so a silent microphone or silent system stream does not create empty labeled turns.
- [x] Keep normal dictation and Ask Selection independent from this meeting-only source path.

### 2. Build labeled raw transcript text

Goal: Save and display a readable raw transcript without adding a database migration unless the implementation proves one is needed.

- [x] Transcribe non-silent microphone chunks as `Me` and non-silent system-audio chunks as `Them`.
- [x] Merge source transcripts in meeting chunk order, combining adjacent chunks from the same source when that keeps the text easier to read.
- [x] Record per-source chunk timing in logs so regressions in meeting transcription latency are visible.
- [x] Save the formatted labeled transcript in the existing `transcription_text` field.
- [x] Feed the same labeled transcript into the meeting summary path so summaries can use the source context without treating `Them` as a verified person identity.
- [x] Preserve current behavior when only one source is active, degraded, or successfully transcribed.

### 3. Render the labeled transcript cleanly

Goal: Make the distinction visible in the raw transcript surface without turning the main meeting screen into a transcript view.

- [x] Update the raw transcript modal rendering to recognize `Me:` and `Them:` blocks and show compact source labels.
- [x] Keep raw transcript behind the existing `Raw transcript` button.
- [x] Update UX review mock data so the session workspace includes a labeled meeting transcript.
- [x] Keep plain transcript rendering working for older history entries that do not contain labels.

### 4. Add focused validation

Goal: Catch the regression that would erase source labels or route meeting audio through the old mixed-only path.

- [x] Add focused Rust tests for formatting labeled transcript segments, skipping empty source output, and preserving source order.
- [x] Add focused Rust tests or module tests for the meeting audio drain/stop source shape and quiet-source gating.
- [x] Add a frontend test or UX-review smoke for the raw transcript modal with `Me` and `Them` blocks.
- [x] Run the targeted Rust tests for full-system meeting transcription.
- [x] Run `cargo check`.
- [x] Run `npm run build`.
- [x] Run UI-level verification for the meeting raw transcript surface and record what was visually checked.

### 5. Close out

- [x] Run final `$deliver` review against this plan and the completed diff.
- [x] Fix any in-scope review findings.
- [x] Archive this execution plan after all checkboxes are complete.
- [x] Commit the completed implementation and closeout changes.

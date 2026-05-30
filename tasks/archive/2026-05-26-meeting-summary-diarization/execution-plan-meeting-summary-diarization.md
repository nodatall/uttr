# Meeting Summary

Goal: Improve Uttr meetings so transcripts stay live and summaries update once per minute in a cleaner four-section shape without adding a database migration.

Please review this before I start.
Tell me what is wrong, missing, or out of order.

Deliver implementation instruction:
When asked to implement this doc, load the `$deliver` skill, use this file as the approved execution plan, scan every checkbox, and continue through final review, archive movement, commit, and finalization before the final handoff.

## What We Know

- Uttr already records full-system meetings in 10-second audio chunks.
- Summary calls now run on a one-minute cadence, with one final summary pass after stop.
- The current live summary prompt still asks for broad Markdown with `Summary`, `Action items`, and `Notable points`.
- The app and backend fallback both build live-summary prompts, so they must stay aligned.
- Current history storage is enough for this work: raw transcript stays in `transcription_text`, rendered summary stays in `post_processed_text`.
- No migration should be added for structured summary state.
- Diarization is out of scope for this plan.

## Steps

### 1. Tighten the rolling summary contract

Goal: Make every live summary use the same four sections and stop asking for extra headings.

- [x] Replace the app live-summary system and user prompts with a four-section meeting prompt: `Current gist`, `Key points`, `Action items`, and `Timeline`.
- [x] Mirror the same four-section prompt in the backend summary fallback so Codex, BYOK OpenAI, and backend summaries behave consistently.
- [x] Preserve the one-minute live summary cadence and final stop-time summary pass.
- [x] Add focused tests proving the app prompt and backend prompt only request the four allowed sections.

### 2. Render the four-section summary cleanly

Goal: Make the meeting screen easy to scan without changing history storage.

- [x] Update the meeting summary UI to render the four Markdown sections cleanly instead of showing the whole summary as one pre-wrapped paragraph.
- [x] Keep raw transcript behind the existing `Raw transcript` button.
- [x] Update the UX review mock data to exercise the four-section summary shape.
- [x] Capture a browser screenshot of the meeting summary panel and check for clipping, awkward spacing, and unreadable text.

### 3. Add runtime-only structured summary support

Goal: Let Uttr validate and render a stable summary shape while still saving the existing text fields.

- [x] Add Rust types for runtime summary state: current gist, key points, action items, and timeline.
- [x] Add parser/validator code that accepts provider JSON only when it matches the expected summary shape.
- [x] Render valid structured summary state back into Markdown for the current `summary_text` event field and `post_processed_text` history field.
- [x] Keep invalid or incomplete provider output from blanking the existing summary.
- [x] Add focused Rust tests for valid JSON, invalid JSON, Markdown rendering, and fallback-to-previous-summary behavior.

### 4. Validate and close out

- [x] Run focused Rust tests for summary cadence, prompt construction, and structured rendering.
- [x] Run backend summary route or helper tests for the mirrored prompt.
- [x] Run `npm run build`.
- [x] Run `npm run format:check`.
- [x] Run a targeted Playwright or UX-review smoke for the meeting summary panel.
- [x] Run final `$deliver` review against this plan, fix any in-scope findings, then archive the plan and commit the completed work.

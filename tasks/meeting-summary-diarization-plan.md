# Meeting Summary and Diarization Plan

- Current repo state:
  - Uttr already records live meeting chunks every 10 seconds via `FULL_SYSTEM_LIVE_CHUNK_SECONDS` in `src-tauri/src/actions.rs`.
  - Each chunk is transcribed through `TranscriptionManager::transcribe_with_source(..., Some("full_system_audio"))`.
  - The current live summary prompt is plain Markdown-oriented and asks for `Summary`, `Action items`, and `Notable points`.
  - The summary is stored as one Markdown string in `FullSystemLiveRuntime.summary_text`, emitted as `SessionWindowStatePayload.summary_text`, and saved to history as `post_processed_text`.
  - The fallback backend summary route in `marketing-site/lib/openai/session-summary.ts` uses the same broad prompt shape, so prompt/schema changes need to be mirrored in both app and backend.
  - There is no diarization data model today. The transcript is a single appended text string, not speaker turns.

- Phase 1: Replace the live summary prompt with the smaller product shape.
  - Change `FULL_SYSTEM_SUMMARY_SYSTEM_PROMPT` in `src-tauri/src/actions.rs` to describe Uttr as a live macOS meeting summarizer.
  - Replace `build_live_summary_prompt(...)` with a stricter prompt that only allows:
    - `Current gist`
    - `Key points`
    - `Action items`
    - `Timeline`
  - Keep the output Markdown for the first pass because `HomeWorkspace.tsx` and history already render summary text directly.
  - Keep 10-second audio chunks for fast transcript updates.
  - Update the visible summary once per minute, plus one final pass after stop, so the summary feels stable instead of jumpy.
  - Prompt against the full transcript-so-far for now, because that is how the current runtime is wired.
  - Update `marketing-site/lib/openai/session-summary.ts` to use the same four-section prompt so Codex, BYOK OpenAI, and backend fallback behave consistently.

- Phase 2: Add structured summary state internally, then render it as Markdown.
  - Add Rust types for a meeting summary state:
    - `current_gist: String`
    - `key_points: Vec<SummaryPoint>`
    - `action_items: Vec<ActionItem>`
    - `timeline: Vec<TimelineEvent>`
  - Store the structured state in `FullSystemLiveRuntime` alongside or instead of `summary_text`.
  - Ask summary providers for JSON only, validate it, then render it to Markdown before emitting to the existing UI.
  - Keep the existing `summary_text` event field and `post_processed_text` history field for compatibility.
  - Add focused tests for:
    - prompt contents include only the four allowed sections
    - JSON-to-Markdown rendering
    - invalid JSON falls back to the previous summary instead of blanking the meeting

- Phase 3: Add a diarized transcript model without blocking the current meeting workflow.
  - Introduce a `DiarizedTurn` type with:
    - `start_time`
    - `end_time`
    - `speaker`
    - `text`
  - Add a `diarized_turns: Mutex<Vec<DiarizedTurn>>` or equivalent runtime field.
  - Continue storing the plain transcript string for raw transcript/history compatibility.
  - Render speaker turns into a compact prompt block for the summarizer:
    - `[00:01:10-00:01:20] Speaker 1: ...`
    - `[00:01:20-00:01:30] Speaker 2: ...`
  - Update the summary prompt to say speaker labels are hints only and real names must not be guessed.

- Phase 4: Choose and integrate diarization.
  - Treat diarization as an audio-layer feature, not a summarizer feature.
  - First implementation should support stable generic labels like `Speaker 1`, `Speaker 2`, and `Me`.
  - Use the existing split between microphone and system audio to label the local microphone as `Me` when reliable.
  - Add a provider interface around diarization so the app can support:
    - no diarization: all turns are `Unknown speaker`
    - local or backend diarization: `Speaker 1`, `Speaker 2`
    - future user-renamed speakers: `Alex`, `Sarah`
  - Run diarization on a larger rolling window than the 10-second transcript chunk, likely 30-90 seconds, while still emitting 10-second transcript updates.
  - Do not block stop/save on live diarization if it is slow; preserve transcript and summary even if speaker labels lag.

- Phase 5: Update the meeting UI for the four-section summary.
  - Keep `HomeWorkspace.tsx` focused on the live summary, matching `docs/DESIGN.md`.
  - For Markdown phase 1, render the four section headings cleanly in the current summary panel.
  - For structured phase 2, move from one `whitespace-pre-wrap` paragraph to section-aware rendering:
    - current gist as a compact paragraph
    - key points as bullets
    - action items as task rows
    - timeline as timestamped rows
  - Keep raw transcript behind the existing `Raw transcript` button.
  - Add a small speaker label treatment only after diarized turns exist.

- Phase 6: Persistence and history compatibility.
  - Keep saving `transcription_text` as the raw transcript.
  - Keep saving rendered summary Markdown in `post_processed_text`.
  - Do not add a migration for structured meeting metadata.
  - Keep any structured summary or diarized-turn state as runtime-only for now, then render it into the existing summary/transcript fields on save.

- Phase 7: Validation.
  - Add Rust unit tests for prompt construction and structured rendering.
  - Add backend route tests for the mirrored summary prompt in `marketing-site/app/api/session/summary/route.test.ts`.
  - Use the existing UX review mock path to verify the four-section summary renders without clipping.
  - Run:
    - `cd src-tauri && cargo test managers::history actions:: --quiet` or narrower prompt tests once added
    - `npm run build`
    - `npm run format:check`
    - targeted Playwright smoke for the meeting summary panel

- Recommended implementation order:
  - First: prompt-only Markdown change with the four sections, mirrored in backend fallback.
  - Second: section-aware UI rendering if Markdown output looks too plain in the app.
  - Third: structured JSON summary state.
  - Fourth: diarization provider and speaker-turn storage.
  - Fifth: speaker rename and speaker-aware history rendering.

- Main product constraints:
  - Do not pretend the summarizer can infer speakers from plain transcript text.
  - Keep speaker IDs stable over perfect naming.
  - Keep live summary updates meaningful rather than rewriting every chunk.
  - Preserve stop behavior: after the user presses stop, UI should show stopped/processing while the final chunk and final summary finish.
  - Keep meetings uncapped in history; only normal transcriptions are subject to the retention limit.

# FreeFlow-Style Post Processing

Goal: Add the FreeFlow-inspired post-processing features that fit Uttr now: custom vocabulary for cleanup, a stronger cleanup contract, text-only app context, and Edit Mode. Screenshot context is out of scope for this plan.

Please review this before I start.
Tell me what is wrong, missing, or out of order.

Deliver implementation instruction:
When asked to implement this doc, load the `$deliver` skill, use this file as the approved execution plan, scan every checkbox, and continue through final review, archive movement, commit, and finalization before the final handoff.

## What We Know

- Uttr already has `custom_words`, but that is local fuzzy correction before normal filtering. The new vocabulary list must stay separate because it supports names, phrases, casing, hyphens, acronyms, and project jargon without changing transcription.
- Uttr already has LLM post-processing in the Rust backend and a Post Processing settings surface in the React UI.
- Normal cleanup should keep using the configured post-processing provider, with Groq as the default provider.
- Edit Mode should prefer the Codex app server when Codex is available and the user is logged in. If that path is unavailable, Edit Mode should fall back to Groq through the normal post-processing provider.
- Uttr already has a Codex app-server path for full-system session summaries in `src-tauri/src/summary_client.rs`; Edit Mode should reuse that client shape instead of introducing a second unrelated Codex integration.
- Screenshot-based context is deliberately deferred.

## Steps

### 1. Add The Vocabulary Setting

Goal: Store a separate vocabulary list that only the cleanup step uses.

- [x] Add `custom_vocabulary_terms: Vec<String>` to `AppSettings` with an empty default and generated frontend bindings.
- [x] Add one backend update command, register it with Tauri/Specta, and normalize terms on save: trim whitespace, drop blank lines, dedupe case-insensitively, and cap count and term length.
- [x] Wire the new setting through `settingsStore.ts` so React can save it like the other settings.
- [x] Keep `custom_vocabulary_terms` separate from `custom_words`; do not feed it into local fuzzy correction, Parakeet, Groq STT, or OpenAI STT.
- [x] Add focused settings serialization/default tests so old settings files load with an empty vocabulary list.

### 2. Add The Post Processing UI

Goal: Let users edit vocabulary terms without overbuilding the first version.

- [x] Add a Custom Vocabulary section under Post Processing with a multiline textarea.
- [x] Use one term per line so names, phrases, casing, hyphens, acronyms, and project jargon are preserved.
- [x] Save normalized terms through the backend command and show the normalized text after save or refresh.
- [x] Show concise helper text that this list affects LLM cleanup only, not local fuzzy correction.
- [x] Match the existing settings group style from `docs/DESIGN.md`; do not add a separate list editor yet.
- [x] Visually inspect the changed settings screen in the app or browser when practical.

### 3. Use Vocabulary In LLM Cleanup Only

Goal: Give the cleanup model spelling hints without changing core transcription behavior.

- [x] Append the vocabulary block to the LLM post-processing prompt only when terms exist.
- [x] Use this contract: treat terms as high-priority spelling references, use exact spellings when relevant, and do not insert terms that were not spoken.
- [x] Keep the STT output normal; the cleanup step alone uses the vocabulary as a correction hint.
- [x] Add focused Rust tests for vocabulary normalization and prompt injection.

### 4. Tighten The Cleanup Contract

Goal: Improve cleanup quality without making Uttr invent content.

- [x] Review the existing strict and nuanced cleanup prompts against the FreeFlow-style rules for preserving commands, file paths, acronyms, names, self-corrections, and dictated instructions.
- [x] Update the default cleanup prompt only where it clearly improves Uttr's current behavior.
- [x] Add or update narrow tests around the final prompt assembly so vocabulary and context do not weaken the "return only cleaned transcript" contract.

### 5. Add Text-Only App Context

Goal: Use nearby app context as a spelling and formatting hint without sending screenshots.

- [x] Add a macOS-only context snapshot that can capture the frontmost app name, bundle id, window title, and selected text when permissions allow.
- [x] Feed the text-only context into LLM cleanup as supporting context, not as source material to invent from.
- [x] Fall back cleanly when Accessibility permission or app metadata is unavailable, without requiring Screen Recording permission.
- [x] Store enough debug/history detail to understand whether context was used, without exposing secrets.
- [x] Add focused tests or narrow probes for prompt construction and fallback behavior.

### 6. Add Edit Mode

Goal: Transform selected text with a spoken instruction, preferring the Codex app server when available and falling back to Groq.

- [x] Add an Edit Mode setting and an explicit first invocation path, such as a dedicated shortcut or manual modifier, so normal dictation does not unexpectedly replace selected text.
- [x] Reuse or extract the existing Codex app-server client shape from full-system summaries for Edit Mode transforms.
- [x] Add an Edit Mode transform client that first checks whether the Codex app server is reachable and `account/read` shows the user is logged in.
- [x] Send the Edit Mode transform to the Codex app server when that path is available.
- [x] Fall back to Groq through the normal post-processing provider when Codex is unavailable, not running, not logged in, times out, or returns a typed unavailable response.
- [x] Capture selected text before recording starts, then transcribe the spoken instruction normally.
- [x] Send selected text, spoken instruction, optional text-only context, and custom vocabulary to a transform prompt that returns only replacement text.
- [x] Paste the replacement over the current selection using Uttr's existing paste path.
- [x] Fail safely: if selected text is missing, Codex and Groq both fail, or the transform output is empty or unsafe, do not replace the user's selection with unrelated text.
- [x] Add focused backend tests for transform prompt assembly, Codex-preferred routing, Groq fallback, and no-replacement failure behavior.

### 7. Validate The Whole Feature

- [x] Run focused Rust tests for settings normalization, prompt injection, and transform prompt behavior.
- [x] Run frontend type/build checks so generated bindings, settings store updates, and React usage compile.
- [x] Run formatting checks for changed Rust and frontend files.
- [x] Manually exercise the settings UI and one post-processing flow when practical.
- [x] Run final review against this execution plan and fix any in-scope material findings before archiving the plan.

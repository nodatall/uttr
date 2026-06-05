# Ask Selection Chat Panel

Goal: Make Ask Selection feel like one floating conversation panel: it appears immediately, records inside the panel, answers inside the panel, and supports follow-up chat.

Please review this before I start.
Tell me what is wrong, missing, or out of order.

Deliver implementation instruction:
When asked to implement this doc, load the `$deliver` skill, use this file as the approved execution plan, scan every checkbox, and continue through final review, archive movement, commit, and finalization before the final handoff.

## What We Know

- Normal dictation should keep using the bottom recording overlay.
- Ask Selection should not show the bottom recording/transcribing/processing overlay.
- Ask Selection should open as soon as its shortcut starts recording.
- The panel should be about twice the current size and stay styled like the settings-style Ask Selection panel.
- The first answer should become the start of a chat, with follow-up messages using the same selected text as context.
- Follow-up chat is a panel interaction for the current selection. It does not need a saved chat-history product surface in this plan.
- The panel should not show a title/status label like "Recording in Ask Selection", explanatory copy hints, or placeholder text in the composer.
- Follow-up messages should send with Enter. There should not be a visible send button in the panel.
- The architecture doc keeps `src/overlay/` for the compact bottom overlay and `src/ask-selection/` for the interactive Ask Selection panel.

Visual mockup: [ui-mockup-ask-selection-chat-panel.html](ui-mockup-ask-selection-chat-panel.html)

## Steps

### 1. Open The Panel At Recording Start

Goal: Ask Selection should visibly start in its own panel as soon as the shortcut begins.

- [x] Add Ask Selection panel states for `recording`, `thinking`, `result`, and `error`.
- [x] Show the Ask Selection panel immediately when the Ask Selection shortcut starts recording.
- [x] Clear any previous Ask Selection answer or chat when a new Ask Selection recording starts.
- [x] If selected text cannot be captured, show the error inside the Ask Selection panel instead of falling back to the bottom overlay.
- [x] Keep normal dictation, meetings, and full-system recording on their existing UI paths.

### 2. Move Ask Selection Progress UI Into The Panel

Goal: The bottom recording overlay should not appear during Ask Selection.

- [x] Route Ask Selection recording, speech-to-text, and LLM progress updates to the Ask Selection panel instead of the bottom overlay.
- [x] Render a centered in-panel recording state while audio is being captured.
- [x] Switch directly from `recording` to `thinking` when recording stops, including while Groq speech-to-text is running.
- [x] Render the current Ask Selection `RoseThreeLoader` in-panel for the `thinking` state.
- [x] Keep the close button, Escape close, and drag behavior working in every state.

### 3. Enlarge And Polish The Panel

Goal: The panel should feel like a small chat window instead of a compact result bubble.

- [x] Increase the native Ask Selection panel size from `420x260` to about `760x520`.
- [x] Update cursor-relative positioning and screen-edge clamping for the larger size.
- [x] Update the Ask Selection CSS so the larger panel has a scrollable message area and a stable bottom composer.
- [x] Keep the composer visually quiet: no placeholder text and no visible send button.
- [x] Keep scrollbars visually quiet and keep the dark translucent settings-style surface.

### 4. Add Follow-Up Chat

Goal: After the first answer, the user can keep chatting about the same selected text.

- [x] Store an Ask Selection session with selected text, spoken prompt, answer messages, and a session id.
- [x] Render the initial spoken prompt and assistant answer as chat messages.
- [x] Add a compact bottom textarea for typed follow-up messages after the first answer, with Enter to send and Shift+Enter for a newline.
- [x] Send follow-up messages through a new backend command that uses the selected text plus chat history as context.
- [x] Show the new user message immediately and show an in-panel assistant pending state while the follow-up answer is generated.
- [x] Keep click-to-copy behavior available for assistant answers without replacing visible text.

### 5. Validate The Flow

- [x] Add focused Rust tests for Ask Selection state/session payloads and follow-up prompt construction.
- [x] Run the focused Ask Selection Rust tests.
- [x] Run the frontend build.
- [x] Verify the built Ask Selection panel flow: panel appears in recording, bottom overlay is not part of the Ask Selection surface, listening/thinking happen in-panel, answer appears, follow-up chat works, close/Escape work, and native smoke preflight still resolves a normal dictation provider. The full native hotkey smoke was not run because an existing Tauri dev process was active.

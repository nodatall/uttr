# Ask Selection

Goal: Turn the current Edit Mode behavior into Ask Selection: select text, speak a request, and show the answer in a small floating panel instead of replacing text.

Please review this before I start.
Tell me what is wrong, missing, or out of order.

Deliver implementation instruction:
When asked to implement this doc, load the `$deliver` skill, use this file as the approved execution plan, scan every checkbox, and continue through final review, archive movement, commit, and finalization before the final handoff.

## What We Know

- The current `edit_mode` shortcut already captures selected text, records a spoken instruction, transcribes it, sends the selected text plus instruction to Codex app-server first, and falls back to the post-processing provider.
- The current Edit Mode then pastes the model output back into the active app. Ask Selection should stop doing that.
- The user wants a simple box near the mouse: loading while the LLM thinks, result text when done, click the text to copy, `x` to close, outside click to close, and `Esc` to close. The panel should not show an “Ask Selection” title.
- Copy feedback should not replace the answer text. Keep the answer visible and show a small `Copied` status in the panel header.
- The box should feel like Uttr settings UI, not like the compact recording wave overlay.
- The existing `edit_mode` setting key and shortcut id can stay for compatibility, while labels and behavior become Ask Selection.
- Mockup: `tasks/mockups/ask-selection-panel.html` shows the proposed cursor-positioned panel plus loading, result, and copied states.

## Steps

### 1. Record the boundary before changing it

Goal: Keep this cross-surface change understandable for future work.

- [x] Add or update a minimal `docs/ARCHITECTURE.md` entry for the shortcut, action, overlay, settings, and frontend boundaries touched by Ask Selection.
- [x] Keep the architecture note practical: what each boundary owns, which direction dependencies should flow, and where Ask Selection wiring belongs.

### 2. Keep the shortcut, change the product contract

Goal: Make the existing Edit Mode path behave like Ask Selection without adding a migration.

- [x] Rename the visible settings labels, shortcut labels, and user-facing errors from Edit Mode to Ask Selection.
- [x] Keep the existing `edit_mode` binding id and `edit_mode_enabled` setting key so existing user settings keep working.
- [x] Change the prompt from “transform and replace selected text” to “use selected text as context for the spoken request.”
- [x] Keep Codex app-server as the first LLM path and keep the existing post-processing provider fallback.
- [x] Keep selected text required for this mode. If nothing is selected, show the existing safe error path and do not call the LLM.

### 3. Add a dedicated Ask Selection result panel

Goal: Show the answer near the cursor without changing normal recording overlay behavior.

- [x] Add a small always-on-top Ask Selection panel instead of making the recording overlay interactive.
- [x] Position the panel below and to the right of the mouse when possible, with edge clamping so it stays on screen.
- [x] Show the panel in a loading state after speech transcription finishes and while the LLM request is running.
- [x] Replace the loading state with the model output when the LLM returns.
- [x] Hide the panel on `Esc`, top-right `x`, or outside click/focus loss.
- [x] Make clicking the result text copy the answer to the clipboard, with only a subtle header copied state and no extra copy button.
- [x] Keep the existing recording overlay non-interactive and unchanged for normal dictation, meetings, and transcribing states.
- [x] Use the existing settings Rose loader style for the loading state instead of a plain spinner.

### 4. Wire Ask Selection into the existing recording flow

Goal: Reuse the current audio, transcription, provider, context, and history paths while removing paste.

- [x] Keep the existing recording and transcribing overlay states while the user is speaking.
- [x] When the spoken request is transcribed, open the Ask Selection panel near the cursor and show loading.
- [x] When the answer is ready, send it to the panel instead of calling the paste path.
- [x] Keep saving history for the spoken request and answer, using an Ask Selection prompt label.
- [x] If the LLM fails or returns empty output, show the error in the panel and emit the existing transcription error event.

### 5. Match Uttr UI style

Goal: Make the panel look like a native Uttr surface.

- [x] Style the panel with the same dark translucent surface, subtle border, rounded corners, text sizing, spacing, and shadow used by settings-style surfaces.
- [x] Use `tasks/mockups/ask-selection-panel.html` as the visual reference, adjusting only when implementation constraints or screenshot review show a better fit.
- [x] Keep the panel chrome minimal: no title text, only the quiet `x` close affordance.
- [x] Keep the panel readable for short answers and longer paragraph output, with a max height and scrolling when needed.
- [x] Add a small `x` icon button in the top-right corner that is visually quiet but discoverable.
- [x] Update `docs/DESIGN.md` with the durable Ask Selection panel rule.

### 6. Validate behavior

- [x] Add Rust tests for the Ask Selection prompt contract and result-cleaning tag.
- [x] Add Rust tests for cursor-relative panel positioning and screen-edge clamping.
- [x] Use browser/Playwright visual coverage for the panel loading state where practical.
- [x] Run focused Rust tests for the changed action and overlay paths.
- [x] Run `bun run lint`, `bun run format:check`, `bun run build`, and `bun run check:translations`.
- [x] Visually inspect the production panel loading state and the mockup result/copy states in browser screenshots for spacing, clipping, `x`, and copied-state behavior.

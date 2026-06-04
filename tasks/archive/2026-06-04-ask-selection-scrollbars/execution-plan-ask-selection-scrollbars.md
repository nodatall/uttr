# Ask Selection Scrollbars

Goal: Make the Ask Selection panel scrollbar feel native to the dark floating panel instead of showing a bright sidebar while scrolling.

Please review this before I start.
Tell me what is wrong, missing, or out of order.

Deliver implementation instruction:
When asked to implement this doc, load the `$deliver` skill, use this file as the approved execution plan, scan every checkbox, and continue through final review, archive movement, commit, and finalization before the final handoff.

## What We Know

- The Ask Selection panel styles live in `src/ask-selection/AskSelectionPanel.css`.
- The scrollable area is `.ask-selection-body`.
- The app already has global 10px scrollbar rules in `src/App.css`, so Ask Selection needs local overrides if it should look skinnier than the rest of the app.
- `docs/DESIGN.md` says Ask Selection should use a settings-style dark translucent surface with a compact close button and no title.
- This plan is only for Ask Selection panel scrollbar styling.

## Steps

### 1. Tune the panel scrollbar

- [x] Add Ask Selection-specific scrollbar styles to `.ask-selection-body`.
- [x] Override the global WebKit scrollbar width locally so the Ask Selection scrollbar is skinnier than the app default.
- [x] Make the scrollbar thin and subtle on the Tauri/macOS webview path.
- [x] Make the scrollbar track transparent or visually matched to the dark panel background.
- [x] Keep the thumb visible enough for scrolling, but muted enough that it does not read as a white sidebar or bright gutter.

### 2. Keep the scope narrow

- [x] Avoid changing global scrollbar styles or main app/sidebar scrollbars.
- [x] Avoid changing the panel layout, content, close button, loader, or copy behavior.
- [x] Keep the change in the frontend Ask Selection styling boundary unless visual testing proves the native panel surface itself needs a small adjustment.

### 3. Verify the rendered state

- [x] Produce or open an Ask Selection panel with enough result text to overflow.
- [x] Scroll the panel and visually check that the scrollbar is skinny and blends into the dark surface.
- [x] Check that the result text still has comfortable right-side spacing when the scrollbar appears.
- [x] Capture a screenshot or note the reason if direct visual inspection is not practical.
- [x] Run the narrow frontend/build check needed for a CSS-only Ask Selection change.

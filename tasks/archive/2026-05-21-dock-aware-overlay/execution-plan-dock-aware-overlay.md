# Dock-Aware Overlay

Goal: Keep the recording overlay above a visible macOS Dock instead of letting it sit behind the Dock.

Please review this before I start.
Tell me what is wrong, missing, or out of order.

Deliver implementation instruction:
When asked to implement this doc, load the `$deliver` skill, use this file as the approved execution plan, scan every checkbox, and continue through final review, archive movement, commit, and finalization before the final handoff.

## What We Know

- The macOS overlay path in `src-tauri/src/overlay.rs` currently positions the overlay from the full monitor frame.
- The non-macOS overlay path already uses `monitor.work_area()`, which is the visible screen area after system UI such as the Dock or taskbar is reserved.
- We want the overlay above the Dock when the Dock is visible.
- We do not want to draw over the Dock.
- We do not need a separate Dock detector if `monitor.work_area()` gives the right visible area.

## Steps

### 1. Make the overlay position math testable

Goal: Verify Dock-related placement without needing a live Dock during tests.

- [x] Add a small pure helper in `src-tauri/src/overlay.rs` that calculates overlay coordinates from monitor bounds, visible work area, scale, overlay size, and overlay position.
- [x] Keep the helper narrow enough that it does not change window creation, panel setup, z-ordering, or overlay state.
- [x] Preserve the current top-position vertical behavior: top overlays should still use the full monitor top plus the existing top offset.

### 2. Use the visible work area on macOS

Goal: Place the macOS bottom overlay inside the visible screen area.

- [x] Update `calculate_overlay_position_for_monitor` so bottom placement uses `monitor.work_area()` instead of the full monitor height.
- [x] Center the overlay horizontally inside `monitor.work_area()` so left-side and right-side Dock layouts are handled.
- [x] For top placement, use the visible work area only for horizontal centering and keep the current vertical placement.
- [x] Keep the existing scale conversion behavior so retina and non-retina monitors keep the same coordinate units as before.
- [x] Keep the existing fallback behavior when the visible work area is effectively the same as the full monitor.

### 3. Add focused regression tests

Goal: Prevent the Dock regression from coming back.

- [x] Add a bottom-Dock test where the visible work area is shorter than the full monitor and the overlay lands above that visible bottom edge.
- [x] Add a left-or-right-Dock test where the visible work area is horizontally shifted or narrowed and the overlay centers in the visible area.
- [x] Add a no-Dock or auto-hidden-Dock test where the visible work area matches the full monitor and the old bottom result is preserved.
- [x] Add a top-position test that proves the top overlay does not unexpectedly move down.

### 4. Validate the change

Goal: Prove the patch compiles and the focused behavior is covered.

- [x] Run `cd src-tauri && cargo fmt -- --check`.
- [x] Run a focused Rust test command for the overlay geometry tests, such as `cd src-tauri && cargo test --lib overlay`.
- [x] Manual Dock-visible smoke check was not run in this automation; the bottom-Dock geometry case is covered by the focused test.
- [x] Manual auto-hidden Dock smoke check was not run in this automation; the matching-work-area geometry case is covered by the focused test.

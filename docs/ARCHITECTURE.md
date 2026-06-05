# Uttr Architecture

This document records the repo boundaries that are easy to blur during desktop feature work.

## Desktop Capture Flow

- `src-tauri/src/shortcut/` owns shortcut registration, settings commands, and routing shortcut events into actions.
- `src-tauri/src/transcription_coordinator.rs` owns push-to-talk versus toggle lifecycle for transcription bindings.
- `src-tauri/src/actions.rs` owns recording start/stop decisions, transcription finalization, post-processing, Ask Selection LLM requests, history writes, tray state, and high-level UI events.
- `src-tauri/src/app_context.rs` owns nearby macOS app context capture. It may provide app, window, and selected text context, but it should not decide product behavior.
- `src-tauri/src/clipboard.rs` owns normal dictation paste/copy behavior. Ask Selection should not use this paste path because it displays answers instead of replacing text.
- `src-tauri/src/managers/full_system_audio.rs` owns full-system meeting source capture. It may return mixed audio for saved playback and source-specific buffers for meeting transcript labeling.

## Overlay And Floating Panels

- `src-tauri/src/overlay.rs` owns native always-on-top windows, screen positioning, monitor clamping, show/hide events, and mic-level forwarding.
- `src/overlay/` owns the compact recording overlay only. It should stay non-interactive and focused on recording, transcribing, processing, warning, and mic-level states.
- `src/ask-selection/` owns the interactive Ask Selection panel. It listens for `ask-selection-state`, renders thinking/result/error states after recording, handles the current-session follow-up chat UI, closes on `Esc` or the close button, and copies assistant answers on click.

## Settings And Labels

- `src-tauri/src/settings.rs` remains the source for persisted shortcut ids and default binding metadata.
- The `edit_mode` setting key and shortcut id are compatibility names. User-facing labels should say Ask Selection.
- `src/components/settings/` owns the settings UI for enabling Ask Selection and editing its shortcut.

## Dependency Direction

- Backend actions may call overlay/window helpers, history, transcription, summary providers, and clipboard utilities.
- Frontend panel code should not know about recording internals. It receives state payloads from Rust and sends only local UI actions such as close, copy, and current-session follow-up messages. Selected text for Ask Selection follow-ups stays backend-side.
- Normal dictation and meeting recording should not depend on Ask Selection UI code.
- Meeting raw transcript labeling is source-based. `Me` maps to local microphone audio, and `Them` maps to captured system audio; individual remote-speaker diarization is a separate feature.

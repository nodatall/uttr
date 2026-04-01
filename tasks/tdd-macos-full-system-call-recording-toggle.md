# TDD: macOS Full-System Call Recording Toggle

## Plain-Language Summary

Uttr already has a microphone recorder and a transcription pipeline. The safest way to add call recording is not to rewrite that path. Instead, the app should add a second macOS-only capture engine for system audio, run it alongside the existing microphone path, and mix both results only for the new full-system shortcut.

When someone turns on the setting, the app should immediately check whether the Mac supports the feature and whether Screen Recording permission is ready. If it is not ready, the app should guide the user, keep the setting off, and turn it on automatically once permission is granted and the app rechecks the state.

The new shortcut should plug into the same binding and coordinator system as the other transcription shortcuts, but it must always behave like a toggle. The current `transcribe` and `transcribe_with_post_process` paths should stay intact so the main dictation flow does not regress.

## Locked Intake Summary

- Goal: Introduce a separate full-system capture path for macOS 13+ that mixes ScreenCaptureKit system audio with the existing microphone capture and feeds the result into the current transcription pipeline.
- Context: The current codebase persists settings in Rust `AppSettings`, mirrors them into generated TS bindings, renders Sound and shortcut settings in React, builds one macOS Swift bridge from `src-tauri/build.rs`, records microphone audio through `AudioRecordingManager`, and serializes transcribe lifecycles through `TranscriptionCoordinator`.
- Constraints: Keep the current microphone path untouched where possible, compile the new macOS bridge in parallel to the Apple Intelligence bridge, add explicit support and permission checks, make the new binding always toggle-style, continue recording if one source fails mid-session, and reuse cancel/overlay/tray/history behavior.
- Done when: The codebase has a support-gated setting and shortcut, a macOS ScreenCaptureKit bridge, a mixed-capture session path, readiness commands and copy updates, and verification coverage for settings, permissions, shortcuts, cancel, capture mixing, and regressions.

## Technical Summary

Add a new macOS full-system recording stack alongside the current microphone-only path. The new stack consists of a Swift ScreenCaptureKit bridge for system-audio lifecycle, a Rust-side mixed-session controller that starts and stops system and microphone capture together, a mixer that converts both sources into transcription-compatible PCM, and coordinator wiring for a new `transcribe_full_system_audio` binding that always uses toggle semantics.

## Scope Alignment to PRD

- Supports `FR-001`, `FR-003`, `FR-004`, and `FR-012` with support/readiness checks plus settings and copy updates.
- Supports `FR-002` and `FR-006` with new persisted settings and binding types across Rust, generated bindings, and frontend stores.
- Supports `FR-007` and `FR-008` by extending the coordinator and shortcut handling with binding-specific semantics instead of global behavior changes.
- Supports `FR-009`, `FR-010`, and `FR-011` by introducing a separate mixed-capture session path that still enters the existing transcription and cancel flows.

## Current Technical Diagnosis

- `src-tauri/src/settings.rs` defines `AppSettings` and default bindings, but it currently has no full-system capture setting or binding.
- `src/bindings.ts` is generated from backend commands/settings and will need to surface the new setting and any new readiness commands.
- `src/stores/settingsStore.ts` uses per-setting command updaters; a special setting enable flow will require custom handling instead of a naive boolean write.
- `src/components/settings/general/GeneralSettings.tsx` renders the current shortcut and sound groups, and currently shows no full-system capture controls.
- `src-tauri/src/transcription_coordinator.rs` currently recognizes only `transcribe` and `transcribe_with_post_process` as transcription bindings and applies global `push_to_talk` semantics to them.
- `src-tauri/src/shortcut/handler.rs` delegates transcription bindings to the coordinator and non-transcription bindings to plain press/release actions.
- `src-tauri/src/managers/audio.rs` owns a microphone-only CPAL recorder and recording state keyed by binding ID.
- `src-tauri/src/utils.rs` cancel flow currently stops the microphone recorder and resets overlay/tray/coordinator state, but it has no concept of a second capture source.
- `src-tauri/build.rs` already compiles a Swift bridge for Apple Intelligence on macOS and provides a useful integration pattern for a second bridge module.
- `src-tauri/Info.plist` currently includes microphone permission copy but will need additional privacy copy for system-audio capture.

## Architecture / Approach

### Chosen design

Keep the current microphone recorder intact and introduce a parallel macOS-only full-system capture engine:

- Swift bridge owns ScreenCaptureKit system-audio start/stop lifecycle and raw PCM buffering.
- Rust bridge glue in a dedicated module such as `src-tauri/src/full_system_audio_bridge.rs` owns the FFI boundary and safe wrappers.
- Existing `AudioRecordingManager` continues to own microphone capture.
- A new Rust-side full-system session controller in a module such as `src-tauri/src/managers/full_system_audio.rs` coordinates both sources for the new binding only.
- On stop, Rust collects the microphone samples plus system-audio samples, resamples and normalizes as needed, mixes them into one transcription-compatible PCM buffer, and then calls the existing transcription pipeline.

This design minimizes regression risk because it avoids turning the current microphone recorder into a multi-source abstraction before the feature is proven.

### Rejected design

- Extending `AudioRecordingManager` into a single generic multi-source recorder.
  - Rejected because it would directly touch the stable microphone-only path and increase regression risk in ordinary transcription.
- Replacing the current transcribe shortcut with the new behavior.
  - Rejected because the product requirement is a separate opt-in path with independent shortcut semantics.

## System Boundaries / Source of Truth

- `AppSettings.record_full_system_audio` is the persisted product-level source of truth for whether the feature is enabled.
- Support/readiness state is runtime state derived from macOS version checks, Screen Recording permission, and microphone permission status; it should not be modeled as a permanently persisted truth flag.
- The Swift bridge is the source of truth for ScreenCaptureKit session state and buffered system-audio PCM.
- `AudioRecordingManager` remains the source of truth for microphone session state and buffered microphone PCM.
- `TranscriptionCoordinator` remains the source of truth for keyboard-driven recording lifecycle transitions.
- `TranscriptionManager` remains the source of truth for transcription execution, post-processing, history, and completion signaling.

## Dependencies

- ScreenCaptureKit for system-audio capture on macOS.
- CoreGraphics screen-capture permission helpers for preflight/request behavior on macOS.
- Existing CPAL-based microphone recording path for microphone capture.
- Existing overlay, tray, history, cancel, and transcription managers.
- Existing generated bindings pipeline between Rust commands/settings and `src/bindings.ts`.
- Existing localization files for new settings and permission copy.

## Route / API / Public Interface Changes

### Settings / types

- Add `record_full_system_audio: bool` to Rust `AppSettings`.
- Surface `record_full_system_audio?: boolean` in generated TS bindings.
- Add default binding metadata for `transcribe_full_system_audio`, with `option+ctrl+space` as the macOS default unless a documented conflict is discovered during implementation.

### New Rust commands/helpers

- `get_full_system_audio_support_status()`
  - returns platform/version support plus a user-facing reason when unsupported
- `get_full_system_audio_readiness()`
  - returns readiness state derived from support, Screen Recording permission, and microphone readiness
- `set_record_full_system_audio_enabled(enabled: bool)`
  - `true`: validate support/readiness, request Screen Recording flow when applicable, persist only on success, otherwise leave persisted value false
  - `false`: persist false and unregister/disable the binding from UI/runtime use

The exact names can vary during implementation, but the contract must support immediate enable validation rather than a blind boolean setter.

### New Swift bridge ABI

- `uttr_full_system_audio_is_supported() -> bool`
- `uttr_full_system_audio_preflight_permission() -> PermissionState`
- `uttr_full_system_audio_request_permission() -> PermissionState`
- `uttr_full_system_audio_start_capture(config...) -> StartResult`
- `uttr_full_system_audio_stop_capture(...) -> CapturedPcmResult`
- `uttr_full_system_audio_cancel_capture()`
- `uttr_full_system_audio_cleanup_last_session()`

The bridge may return opaque structs or serialized buffers, but it must expose start, stop, cancel, permission, and error-reporting surfaces callable from Rust.

## Data Model / Schema / Storage Changes

- Persist `record_full_system_audio` in `settings_store.json` through `AppSettings`.
- Persist the new binding in the existing `bindings` map with a platform-specific default shortcut.
- No database or history schema changes are required because the mixed session still produces one final PCM payload for the existing transcription/history path.
- Runtime readiness state should remain transient and should be fetched or recomputed rather than stored permanently in settings.

## Technical Requirements (`TDR-*`)

### TDR-001 Settings and generated bindings

Add `record_full_system_audio` and `transcribe_full_system_audio` across Rust settings defaults, generated TS bindings, frontend settings store handling, and localization/copy surfaces.

### TDR-002 Support and permission readiness flow

Implement explicit support and readiness checks for macOS full-system capture, including immediate validation when the user enables the setting, a false-on-failure persisted state, and automatic re-enable when permission is later granted and readiness is rechecked.

### TDR-003 macOS ScreenCaptureKit bridge

Add a dedicated Swift bridge module for ScreenCaptureKit system-audio capture, compiled from `src-tauri/build.rs` in parallel with the existing Apple Intelligence bridge rather than folded into it.

### TDR-004 Mixed-session controller

Create a Rust-side controller for the new binding that starts ScreenCaptureKit system-audio capture and microphone capture together, stops them together, and returns one mixed PCM buffer to the transcription manager.

### TDR-005 Binding-specific coordinator behavior

Extend shortcut/coordinator handling so `transcribe_full_system_audio` is treated as a transcription binding with forced toggle semantics, while `transcribe` and `transcribe_with_post_process` keep their current semantics.

### TDR-006 Cancel and failure-path integration

Update cancel and lifecycle cleanup so a full-system session stops both capture sources, clears any in-progress bridge state, and restores overlay/tray/coordinator state the same way existing recording cancel does.

### TDR-007 Partial-source degradation

If one source fails during a mixed session, continue with the remaining source, mark the degraded state for logs/UX if appropriate, and still attempt transcription with the surviving audio.

### TDR-008 Audio normalization and mixing

Normalize sample rate, channel count, and amplitude between microphone and system-audio buffers, then mix into a mono or otherwise transcription-compatible PCM buffer consistent with the current pipeline input expectations.

### TDR-009 Copy and permission messaging

Update settings/onboarding/localization copy and macOS privacy strings so microphone access and Screen Recording / system-audio access are clearly distinguished.

### TDR-010 Verification coverage

Add or update tests and verification steps covering settings gating, readiness flow, coordinator behavior, cancel behavior, mixing pipeline behavior, and microphone-path regressions.

## Ingestion / Backfill / Migration / Rollout Plan

- Settings migration is additive only:
  - existing settings files pick up `record_full_system_audio = false`
  - existing bindings maps gain `transcribe_full_system_audio` if missing
- Rollout should be guarded by platform/version checks so unsupported environments never attempt to load active UI behavior.
- The first rollout is macOS-only and should avoid broad refactors to the ordinary microphone path.
- No user data backfill is required beyond normal settings default-merging behavior already used by the app.

## Failure Modes / Recovery / Rollback

- Screen Recording permission missing or denied:
  - recovery: toggle remains false, user sees guidance, readiness can be retried later
- Mic permission granted but Screen Recording denied:
  - recovery: ordinary microphone recording still works; full-system feature remains disabled
- System-audio bridge fails to start:
  - recovery: start should fail cleanly, no partial UI “recording” state should remain
- Microphone fails to start while system audio starts:
  - recovery: continue recording with system audio only if the failure happens after session start; if startup never reaches a viable recording session, fail cleanly and reset
- System-audio source fails mid-session:
  - recovery: continue recording microphone audio and log degraded session state
- Cancel during full-system recording:
  - recovery: stop both sources, clear buffers, reset overlay/tray/coordinator to idle
- Bridge integration causes regressions:
  - rollback: disable or hide the setting on affected macOS targets while keeping the existing microphone path unchanged

## Operational Readiness

- Add structured logging around:
  - support detection
  - permission readiness changes
  - full-system session start/stop
  - per-source failures and degraded sessions
  - mix completion and transcription handoff
- Ensure `Info.plist` contains the required privacy strings for microphone and system-audio capture messaging.
- Ensure build output clearly includes or excludes the ScreenCaptureKit bridge by target OS and architecture as intended.
- Prefer a runtime readiness refresh on settings mount, app focus, or permission-return flow instead of a permanent background poll.

## Verification and Test Strategy

- Frontend settings verification:
  - supported macOS shows the toggle in Sound settings
  - unsupported systems hide or disable the control with explanatory copy
  - the dedicated shortcut appears only when the setting is enabled
- Permission verification:
  - enabling the toggle checks readiness immediately
  - denied or missing Screen Recording permission leaves persisted setting false
  - granting permission while the app is open allows the feature to enable without restart through readiness refresh
- Shortcut verification:
  - `transcribe` behavior is unchanged in both push-to-talk and toggle modes
  - `transcribe_with_post_process` behavior is unchanged
  - `transcribe_full_system_audio` always toggles on press regardless of global `push_to_talk`
- Capture verification:
  - starting full-system recording starts both capture sources
  - stopping returns a mixed PCM buffer accepted by the current transcription manager
  - if one source fails mid-session, the surviving source still reaches transcription
- Cancel verification:
  - cancel stops both sources and clears UI state
- Regression verification:
  - repeated start/stop cycles do not wedge either capture engine
  - sleep/wake and permission changes fail safely
  - ordinary microphone transcription still passes existing checks

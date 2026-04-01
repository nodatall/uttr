See `skills/shared/references/execution/task-management.md` for execution workflow and review guidelines.

# macOS Full-System Call Recording Toggle

## Scope Summary

- Add an opt-in macOS 13+ full-system recording mode that captures system audio plus microphone audio without changing the current microphone-only recording path.
- Add immediate readiness validation, a separate always-toggle shortcut, and a macOS-only ScreenCaptureKit bridge that mixes audio into the existing transcription pipeline.
- Highest-risk areas are permission truthfulness, coordinator semantics for the new binding, cross-language bridge lifecycle, and making sure cancel/repeated sessions do not wedge either capture engine.

## Relevant Files

- `src-tauri/src/settings.rs` - app settings defaults and binding registration live here.
- `src-tauri/build.rs` - existing Swift bridge compilation pattern lives here.
- `src-tauri/swift/apple_intelligence.swift` - example of current Swift bridge structure and C ABI integration.
- `src-tauri/swift/apple_intelligence_bridge.h` - existing bridge header pattern to mirror for the new module.
- `src-tauri/src/transcription_coordinator.rs` - current transcription binding lifecycle and push-to-talk handling.
- `src-tauri/src/shortcut/handler.rs` - shared shortcut routing logic for transcription and non-transcription bindings.
- `src-tauri/src/managers/audio.rs` - microphone recording lifecycle and captured PCM buffering.
- `src-tauri/src/managers/transcription.rs` - transcription pipeline entry point and lifecycle completion handling.
- `src-tauri/src/utils.rs` - centralized cancel path and tray/overlay reset behavior.
- `src-tauri/src/lib.rs` - command registration and app bootstrap wiring.
- `src-tauri/src/commands/audio.rs` - existing settings and audio-related commands pattern.
- `src-tauri/Info.plist` - privacy copy for macOS permissions.
- `src/bindings.ts` - generated frontend bindings that must expose the new setting and readiness commands.
- `src/stores/settingsStore.ts` - setting updater logic and settings refresh handling.
- `src/components/settings/general/GeneralSettings.tsx` - current General and Sound settings layout.
- `src/components/settings/ShortcutInput.tsx` - shortcut control wrapper used for per-binding UI.
- `src/i18n/locales/en/translation.json` - primary localization source for settings and shortcut copy.
- `src/components/onboarding/AccessibilityOnboarding.tsx` - current permission-copy surface that may need distinction between microphone and Screen Recording.
- `tests/e2e/**` - potential E2E coverage location if UI verification is added.

## Task Ordering Notes

- Settings and readiness commands need to land before the frontend toggle can behave truthfully.
- The new binding must be introduced before coordinator/session work can be wired end to end.
- The Swift bridge and Rust mixed-session controller should be built before integrating transcription handoff and cancel behavior.
- Cancel and repeated-session cleanup should be treated as part of the core implementation, not a late polish pass.
- Verification should explicitly cover the unchanged microphone-only path before the work is considered complete.

## Tasks

- [ ] 1.0 Add the settings, binding, and readiness surfaces for full-system recording
  - covers_prd: `FR-001`, `FR-002`, `FR-003`, `FR-004`, `FR-005`, `FR-006`, `FR-012`
  - covers_tdd: `TDR-001`, `TDR-002`, `TDR-009`
  - [x] 1.1 Extend Rust settings defaults and binding metadata for `record_full_system_audio` and `transcribe_full_system_audio`
    - covers_prd: `FR-002`, `FR-006`
    - covers_tdd: `TDR-001`
    - output: `src-tauri/src/settings.rs`
    - verify: `cargo test --manifest-path src-tauri/Cargo.toml settings`
    - done_when: `AppSettings` defaults include the new boolean setting and the bindings map auto-populates `transcribe_full_system_audio` with the planned macOS default without changing existing shortcut defaults.
  - [ ] 1.2 Add backend command contracts for support, readiness, and explicit enable/disable flow
    - covers_prd: `FR-001`, `FR-004`, `FR-005`
    - covers_tdd: `TDR-002`
    - output: `src-tauri/src/commands/audio.rs`, `src-tauri/src/lib.rs`, `src/bindings.ts`
    - verify: `cargo test --manifest-path src-tauri/Cargo.toml`
    - done_when: The backend exposes commands that can report support/readiness and can attempt to enable the feature without blindly persisting `true` when permission is missing.
  - [ ] 1.3 Update frontend settings state and Sound settings UI to use the readiness-aware toggle
    - covers_prd: `FR-003`, `FR-004`, `FR-005`, `FR-006`, `FR-012`
    - covers_tdd: `TDR-001`, `TDR-002`, `TDR-009`
    - output: `src/stores/settingsStore.ts`, `src/components/settings/general/GeneralSettings.tsx`, `src/components/settings/RecordFullSystemAudio.tsx`, `src/components/settings/ShortcutInput.tsx`, `src/i18n/locales/en/translation.json`
    - verify: `npm test`
    - done_when: Supported macOS users can see the toggle in Sound settings, unsupported users get truthful disabled or hidden behavior, and the full-system shortcut UI appears only when the feature is enabled.

- [ ] 2.0 Add the macOS ScreenCaptureKit bridge and permission helpers
  - covers_prd: `FR-001`, `FR-004`, `FR-005`, `FR-009`, `FR-012`
  - covers_tdd: `TDR-002`, `TDR-003`, `TDR-009`
  - [ ] 2.1 Compile a dedicated full-system audio Swift bridge from `build.rs`
    - covers_prd: `FR-009`
    - covers_tdd: `TDR-003`
    - output: `src-tauri/build.rs`, `src-tauri/swift/full_system_audio.swift`, `src-tauri/swift/full_system_audio_stub.swift`, `src-tauri/swift/full_system_audio_bridge.h`, `src-tauri/src/full_system_audio_bridge.rs`
    - verify: `cargo test --manifest-path src-tauri/Cargo.toml`
    - done_when: macOS builds compile a separate ScreenCaptureKit bridge alongside the Apple Intelligence bridge, with stubs or gating where the target cannot support the feature.
  - [ ] 2.2 Implement support and Screen Recording permission helpers on the Swift/Rust boundary
    - covers_prd: `FR-001`, `FR-004`, `FR-005`, `FR-012`
    - covers_tdd: `TDR-002`, `TDR-003`, `TDR-009`
    - output: `src-tauri/swift/full_system_audio.swift`, `src-tauri/src/**`, `src-tauri/Info.plist`
    - verify: `cargo test --manifest-path src-tauri/Cargo.toml`
    - done_when: Rust can query support, preflight permission state, trigger the permission flow, and distinguish Screen Recording access from microphone access in user-facing copy and privacy strings.

- [ ] 3.0 Build the mixed full-system capture session controller
  - covers_prd: `FR-009`, `FR-010`, `FR-011`
  - covers_tdd: `TDR-004`, `TDR-007`, `TDR-008`
  - [ ] 3.1 Add a Rust-side full-system session manager that starts and stops system audio plus microphone capture together
    - covers_prd: `FR-009`, `FR-011`
    - covers_tdd: `TDR-004`, `TDR-007`
    - output: `src-tauri/src/managers/full_system_audio.rs`, `src-tauri/src/lib.rs`
    - verify: `cargo test --manifest-path src-tauri/Cargo.toml`
    - done_when: The app can create a full-system session, start both capture sources, tolerate one source failing after start, and stop the session without altering the current microphone-only manager behavior.
  - [ ] 3.2 Resample, normalize, and mix microphone plus system-audio PCM into the existing transcription input format
    - covers_prd: `FR-009`, `FR-011`
    - covers_tdd: `TDR-004`, `TDR-007`, `TDR-008`
    - output: `src-tauri/src/managers/full_system_audio.rs`, `src-tauri/src/audio_toolkit/audio/recorder.rs`, `src-tauri/src/managers/transcription.rs`
    - verify: `cargo test --manifest-path src-tauri/Cargo.toml`
    - done_when: A completed full-system session produces one transcription-compatible PCM buffer, and degraded single-source sessions still yield usable audio for transcription.

- [ ] 4.0 Integrate the new binding into shortcut, coordinator, and cancel flows
  - covers_prd: `FR-006`, `FR-007`, `FR-008`, `FR-010`, `FR-011`
  - covers_tdd: `TDR-005`, `TDR-006`, `TDR-007`
  - [ ] 4.1 Register `transcribe_full_system_audio` as a transcription binding with forced toggle semantics
    - covers_prd: `FR-006`, `FR-007`, `FR-008`
    - covers_tdd: `TDR-005`
    - output: `src-tauri/src/transcription_coordinator.rs`, `src-tauri/src/shortcut/handler.rs`, `src-tauri/src/settings.rs`
    - verify: `cargo test --manifest-path src-tauri/Cargo.toml`
    - done_when: The new binding starts on first press and stops on second press regardless of `push_to_talk`, while `transcribe` and `transcribe_with_post_process` still follow current behavior.
  - [ ] 4.2 Reuse the existing transcription pipeline and UI state transitions for the full-system path
    - covers_prd: `FR-009`, `FR-010`
    - covers_tdd: `TDR-004`, `TDR-006`
    - output: `src-tauri/src/actions.rs`, `src-tauri/src/managers/transcription.rs`, `src-tauri/src/tray.rs`, `src-tauri/src/overlay.rs`
    - verify: `cargo test --manifest-path src-tauri/Cargo.toml`
    - done_when: Starting and stopping the new binding drives the normal overlay, tray, processing, history, and post-processing flow using the mixed PCM result.
  - [ ] 4.3 Extend cancel and lifecycle cleanup so full-system sessions always reset cleanly
    - covers_prd: `FR-010`, `FR-011`
    - covers_tdd: `TDR-006`, `TDR-007`
    - output: `src-tauri/src/utils.rs`, `src-tauri/src/managers/**`, `src-tauri/src/transcription_coordinator.rs`
    - verify: `cargo test --manifest-path src-tauri/Cargo.toml`
    - done_when: Cancel stops both capture sources, clears bridge/session state, and returns the app to idle without leaving tray, overlay, or coordinator state stuck.

- [ ] 5.0 Update copy and permission UX to match the new behavior
  - covers_prd: `FR-001`, `FR-003`, `FR-004`, `FR-005`, `FR-012`
  - covers_tdd: `TDR-002`, `TDR-009`
  - [ ] 5.1 Add localization and settings copy for the new toggle, shortcut, support gating, and blocked states
    - covers_prd: `FR-003`, `FR-004`, `FR-012`
    - covers_tdd: `TDR-009`
    - output: `src/i18n/locales/en/translation.json`, `src/i18n/locales/**/translation.json`
    - verify: `npm test`
    - done_when: The UI has clear strings for the new setting, dedicated shortcut, unsupported-system state, and Screen Recording guidance that distinguish it from microphone access.
  - [ ] 5.2 Update onboarding or permission surfaces to explain microphone versus Screen Recording access
    - covers_prd: `FR-004`, `FR-005`, `FR-012`
    - covers_tdd: `TDR-002`, `TDR-009`
    - output: `src/components/onboarding/AccessibilityOnboarding.tsx`, `src/App.tsx`
    - verify: `npm test`
    - done_when: Users can understand why microphone-only recording may work while full-system recording remains blocked on Screen Recording access.

- [ ] 6.0 Add verification for the new path and for microphone-only regressions
  - covers_prd: `FR-001`, `FR-004`, `FR-005`, `FR-007`, `FR-008`, `FR-009`, `FR-010`, `FR-011`
  - covers_tdd: `TDR-010`
  - [ ] 6.1 Add focused backend/unit coverage for readiness logic, binding semantics, and mixed-session lifecycle
    - covers_prd: `FR-004`, `FR-005`, `FR-007`, `FR-009`, `FR-010`, `FR-011`
    - covers_tdd: `TDR-010`
    - output: `src-tauri/src/transcription_coordinator.rs`, `src-tauri/src/managers/full_system_audio.rs`, `src-tauri/src/commands/audio.rs`
    - verify: `cargo test --manifest-path src-tauri/Cargo.toml`
    - done_when: Tests exercise enable/disable readiness flow, forced toggle behavior for the new binding, cancel cleanup, degraded-source handling, and transcription handoff.
  - [ ] 6.2 Add frontend or end-to-end coverage for settings gating and unchanged ordinary transcription behavior
    - covers_prd: `FR-001`, `FR-003`, `FR-008`, `FR-012`
    - covers_tdd: `TDR-010`
    - output: `tests/e2e/full-system-audio.spec.ts`, `src/components/settings/RecordFullSystemAudio.tsx`, `src/stores/settingsStore.ts`
    - verify: `npm test`
    - done_when: Verification covers supported-versus-unsupported settings behavior, shortcut visibility gating, and confirms that ordinary microphone transcription UI flows remain unchanged.

# PRD: macOS Full-System Call Recording Toggle

## Plain-Language Summary

Uttr already lets people record their microphone with a shortcut. This change adds a second kind of recording on macOS 13 and later that can hear both the user’s microphone and the sound coming from the Mac, which is useful for calls and meetings.

People turn this on with one setting called `Record full system audio`. When they enable it, Uttr must immediately check Screen Recording access instead of pretending the feature is ready. If access is missing, the toggle turns back off. If the user grants permission, the toggle should turn on without making them restart the app.

This new feature gets its own shortcut and that shortcut always works like an on/off switch: press once to start, press again to stop. The old microphone shortcut keeps working exactly the way it already works, including its current push-to-talk behavior.

## Locked Intake Summary

- Goal: Add an opt-in macOS-only recording mode that captures system audio plus microphone audio for transcription without changing the current microphone-only path.
- Context: The current app exposes microphone and shortcut settings in the frontend, uses persisted `AppSettings` plus generated TS bindings, runs a microphone-only CPAL recorder in Rust, serializes transcribe lifecycle through `TranscriptionCoordinator`, and already has overlay, tray, cancel, history, post-processing, and paste flows that should be reused.
- Constraints: Scope is macOS 13+ only, the feature uses a single toggle rather than a source selector, the dedicated full-system shortcut is always toggle-style and separate from existing bindings, permission UX must happen when the toggle is enabled, unsupported systems must not expose a broken control, and if one source fails during capture the session should continue with the remaining source.
- Done when: Users on supported macOS can enable the setting, complete permission readiness, see the dedicated shortcut, start and stop mixed capture with that shortcut, cancel cleanly, and receive transcription/history/output behavior that matches the existing pipeline while ordinary microphone transcription remains unchanged.

## Target User / Audience

- macOS users who record calls, meetings, demos, or interviews where both remote audio and local speech matter.
- Existing Uttr users who want a dedicated call-recording path without changing the current voice shortcut.
- Maintainers who need the new feature to fit the current settings, shortcut, overlay, and transcription flows with minimal regression risk.

## Problem Statement

Uttr’s current recording flow is microphone-only. That works for dictation, but it does not capture the remote side of a call. Users need an opt-in full-system recording mode on macOS that can mix call audio with the user’s microphone and feed that combined result into the existing transcription pipeline.

## Current-State / Product Diagnosis

- The frontend currently exposes shortcut configuration under General settings and microphone controls under Sound settings.
- The backend currently records only microphone audio through the existing `AudioRecordingManager`.
- `TranscriptionCoordinator` currently treats only `transcribe` and `transcribe_with_post_process` as transcription bindings.
- The current cancel flow, overlay, tray, history, post-processing, and paste behavior already exist and should be reused rather than redesigned.
- Permission UX today clearly covers microphone and accessibility, but it does not distinguish Screen Recording access for system-audio capture.
- The app already has a Swift bridge pattern for Apple Intelligence, which reduces integration risk for a parallel macOS bridge.

## Product Goal

Ship a macOS 13+ full-system recording feature that captures system audio and microphone audio together through a separate opt-in path, uses a dedicated always-toggle shortcut, validates permission readiness immediately, and preserves the existing microphone recording experience unchanged.

## Success Criteria

- Supported macOS users can discover the `Record full system audio` toggle under Sound settings.
- Enabling the toggle immediately validates support and Screen Recording readiness instead of silently leaving the feature in a fake ready state.
- If permission is missing or denied, the toggle returns to `Off` and the UI tells the user what to do.
- If permission is granted while the app is running, the toggle turns on without requiring restart.
- The new full-system shortcut starts on first press and stops on second press regardless of the global `push_to_talk` setting.
- The existing `transcribe` and `transcribe_with_post_process` bindings keep their current behavior.
- The final transcription path continues to reuse overlay, tray, cancel, history, post-processing, and paste behavior.

## Explicit Non-Goals

- Replacing the existing microphone-only recording flow.
- Turning the feature into a general audio-source selector.
- Supporting app-specific audio capture or per-window capture in this version.
- Supporting system-audio-only recording without microphone input.
- Adding this feature to Windows, Linux, or macOS versions earlier than 13.
- Redesigning the broader onboarding or settings structure beyond what is needed for this feature.

## User Stories or Primary User Outcomes

- As a macOS call user, I can enable full-system recording and know immediately whether the app is actually ready to use it.
- As a macOS call user, I can start and stop mixed recording with a dedicated shortcut without affecting my normal microphone shortcut.
- As a user who prefers push-to-talk for normal dictation, I can still use a toggle-style shortcut for full-system call capture.
- As a user who denies Screen Recording permission, I get a clear blocked state instead of a misleading enabled feature.
- As a user whose permission changes while the app is open, I can use the feature without restarting if the system now allows it.
- As an existing Uttr user, my ordinary microphone transcription and post-processing flows still behave as before.

## Functional Requirements (`FR-*`)

### FR-001 Supported-platform gating

The feature must be available only on macOS 13 and later. Unsupported platforms or earlier macOS versions must not present an active broken control.

### FR-002 Persisted feature setting

The app must add and persist `record_full_system_audio` in app settings and generated TypeScript bindings.

### FR-003 Sound settings control

The frontend must surface a single Sound setting labeled `Record full system audio`.

### FR-004 Immediate readiness validation

When a user enables `Record full system audio`, Uttr must immediately check support and Screen Recording readiness. The toggle must flip back off if permission is unavailable or denied.

### FR-005 Auto-enable after grant

If the user grants the required Screen Recording permission while the app is running, the feature must become enabled without requiring restart when feasible in the existing app flow.

### FR-006 Dedicated shortcut exposure

Uttr must add a dedicated shortcut binding for full-system recording, using a binding ID such as `transcribe_full_system_audio`, assign it a macOS default such as `option+ctrl+space`, and show that shortcut only when the feature is enabled.

### FR-007 Full-system shortcut semantics

The dedicated full-system shortcut must always use toggle semantics: first press starts recording, second press stops recording, regardless of the global `push_to_talk` setting.

### FR-008 Existing shortcut preservation

The existing `transcribe` and `transcribe_with_post_process` bindings must remain available and preserve their current behavior.

### FR-009 Mixed capture result

Starting the full-system shortcut must capture both system audio and microphone audio and send the mixed result through the existing transcription pipeline.

### FR-010 Existing UX reuse

The new path must reuse the existing overlay, tray, cancel, history, post-processing, and paste flows wherever possible.

### FR-011 Graceful partial-source failure

If either the microphone source or the system-audio source fails during a full-system recording, the session must continue with the remaining source instead of aborting the entire recording.

### FR-012 Clear permission copy

Uttr must distinguish microphone access from Screen Recording / system-audio access in settings and onboarding copy so users understand which permission is blocked.

## Acceptance Criteria

- AC-001 (`FR-001`, `FR-003`): On macOS 13 or later, the user can see the `Record full system audio` setting under Sound.
- AC-002 (`FR-001`, `FR-003`): On unsupported platforms or older macOS versions, the setting is hidden or clearly disabled with explanatory copy.
- AC-003 (`FR-002`, `FR-004`): Enabling the toggle triggers an immediate support and readiness check instead of passively storing `true`.
- AC-004 (`FR-004`): If Screen Recording permission is missing or denied, the toggle returns to `Off` and the user sees guidance.
- AC-005 (`FR-005`): After the user grants Screen Recording access while the app is open, the toggle becomes enabled without restart when the app rechecks readiness.
- AC-006 (`FR-006`, `FR-007`): The full-system shortcut is visible only when the feature is enabled and uses press-once-to-start / press-again-to-stop behavior.
- AC-007 (`FR-007`, `FR-008`): Global `push_to_talk` does not change the full-system shortcut’s toggle behavior and does not change the existing shortcut behavior.
- AC-008 (`FR-009`): A successful full-system recording includes both remote/system audio and local microphone audio in the resulting transcription input.
- AC-009 (`FR-010`): Full-system recordings still drive the expected overlay, tray, history, post-processing, and paste behavior.
- AC-010 (`FR-010`): The cancel shortcut stops an in-progress full-system recording cleanly and returns the app to the normal idle state.
- AC-011 (`FR-011`): If one capture source fails mid-session, the recording continues with the remaining source and still produces a usable transcription attempt.
- AC-012 (`FR-008`, `FR-012`): Ordinary microphone transcription continues to work even when the full-system feature is disabled or blocked by Screen Recording permission.

## Product Rules / UX Rules / Content Rules

- `Record full system audio` means system audio plus microphone audio together, not a source selector and not system-only capture.
- The full-system shortcut is a separate action and must not replace or repurpose `transcribe`.
- The full-system shortcut always behaves as a toggle even when the app is otherwise configured for push-to-talk.
- The feature must never appear enabled if Uttr cannot actually use it.
- Permission guidance must clearly separate:
  - microphone access for microphone capture
  - Screen Recording access for system-audio capture
- Unsupported systems should prefer a disabled or hidden control with explanatory copy over a visible but broken toggle.

## Constraints and Defaults

- Initial scope is macOS 13+ only.
- The feature is opt-in and defaults to disabled.
- Existing microphone-only recording remains the low-risk default path.
- Permission handling begins when the toggle is enabled, not at first shortcut press.
- The default macOS shortcut for `transcribe_full_system_audio` is `option+ctrl+space` unless implementation constraints force a documented change.
- App-specific audio filtering and capture-source selection are deferred.
- The user decision for mid-session failures is to keep recording with the surviving source.
- The full-system shortcut should appear only when the feature is enabled and ready enough to use.

## Success Metrics / Guardrails

- Guardrail: the existing microphone-only path must not regress in shortcut behavior, recording lifecycle, or transcription output.
- Guardrail: failed or denied permission attempts must leave the UI in a truthful state.
- Guardrail: repeated start/stop cycles must not wedge the capture session or leave tray/overlay state stuck.
- Guardrail: cancel must always restore the app to idle even for mixed-capture sessions.
- Guardrail: the plan should favor reuse of current transcription UX and avoid broad coordinator rewrites unless necessary.

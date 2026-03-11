# PRD: Improve First-Word Capture with Recorder Pre-Roll

## Plain-Language Summary

When someone presses the transcription hotkey and starts talking right away, the app can miss the first word. This change makes the recorder keep a tiny recent slice of microphone audio in memory and include it when recording starts, so speech that began just before the key press is still captured. The app should feel the same to users, keep the same default microphone mode, and not add any new settings in this first version.

## Target User / Audience

- People using on-demand transcription with push-to-talk enabled.
- People who speak immediately when they press the shortcut and expect the first word to appear reliably.
- Internal maintainers who need a narrow, low-regression fix that preserves current UX defaults.

## Problem Statement

On-demand transcription can miss the first spoken word or syllable when speech begins just before or at hotkey press. The likely failure is capture-start timing inside the recorder pipeline, not a user-visible settings problem and not primarily a model quality problem.

## Current-State / Product Diagnosis

- The product defaults are already aligned with the desired UX: `push_to_talk` is enabled and `always_on_microphone` is disabled by default.
- On-demand mode prewarms the microphone stream and keeps it open briefly after recording ends, but the recorder still treats `Start` as “begin capturing from now.”
- Current recorder startup logic includes a short passthrough window after `Start`, but that only helps frames that arrive after recording has already started.
- If speech begins before or exactly at keydown while the warm stream is already open, the user can lose the beginning of the utterance.

## Product Goal

Improve first-word reliability in on-demand transcription by making recording start include a recent slice of already-captured microphone audio, without changing the current user workflow, settings model, or microphone defaults.

## Success Criteria

- Immediate speech at keydown consistently retains the first word when the microphone stream is already open.
- No duplicated leading audio appears in incremental transcription or final transcripts.
- Existing pause handling and VAD stability do not noticeably regress in normal on-demand use.
- Users do not need to change settings or microphone mode to benefit from the fix.

## Explicit Non-Goals

- Changing the default microphone mode or encouraging always-on mode by default.
- Adding a new user-facing setting for pre-roll duration in v1.
- Changing the 45 second on-demand idle keepalive in this pass.
- Fixing cases where the microphone stream has already been fully closed after a long idle period.
- Retuning Silero or smoothed VAD thresholds unless recorder pre-roll testing proves that is still required.

## User Stories or Primary User Outcomes

- As a push-to-talk user, I can press the shortcut and start speaking immediately without losing my first word.
- As a user who has been idle for a short period but still has a warm microphone stream, I get the same UX as today with more reliable capture at the beginning.
- As a maintainer, I can ship this fix without changing settings schema, onboarding, or user education.

## Functional Requirements (`FR-*`)

### FR-001 Recording start must include recent audio

When the recorder is already receiving microphone frames, starting a new recording must prepend a bounded recent slice of audio captured immediately before `Start`.

### FR-002 Existing default microphone behavior must stay unchanged

The fix must preserve the current default experience of `push_to_talk: true` and `always_on_microphone: false`, with no new user-facing configuration in v1.

### FR-003 Incremental and final transcription must remain linear

The recording produced for incremental drains and final stop must behave as one continuous audio stream with no duplicated pre-roll and no broken ordering.

### FR-004 Existing pause handling must remain acceptable

The change must not materially degrade current pause detection or the user-visible stability of incremental transcription chunking.

### FR-005 Long-idle closed-stream cases must be explicitly deferred

If the microphone stream has already been closed after a long idle, that case remains outside the scope of this plan and must not silently widen implementation scope.

## Acceptance Criteria

- AC-001 (`FR-001`): In on-demand mode with the microphone stream already open, speech that begins slightly before or exactly at hotkey press is present in the recording returned from the recorder.
- AC-002 (`FR-001`, `FR-003`): The prepended audio is capped to a fixed recent window and does not accumulate across recordings.
- AC-003 (`FR-003`): Multiple `Drain` calls after one `Start` do not re-emit the same pre-roll audio more than once.
- AC-004 (`FR-002`): No settings schema, defaults payload, or user-visible microphone mode behavior changes are required for this release.
- AC-005 (`FR-004`): Manual validation does not show a noticeable regression in pause handling or VAD stability during normal on-demand use.
- AC-006 (`FR-005`): Planning and implementation notes clearly mark long-idle closed-stream misses as deferred rather than partially addressed.

## Product Rules / UX Rules / Content Rules

- `Start` should still feel instantaneous to the user; the UX remains “press and speak.”
- The app must not surface new controls, labels, or onboarding copy for pre-roll in v1.
- Audio feedback behavior remains compatible with the existing push-to-talk flow and should be included in manual validation.
- The product contract is reliability-oriented: a little extra leading silence is acceptable if it improves first-word capture and does not create duplicate speech.

## Constraints and Defaults

- Default implementation target is a 500 ms pre-roll window to favor reliability.
- Existing 350 ms startup passthrough remains in place for the first implementation pass.
- Existing VAD threshold and smoothed onset settings remain unchanged initially.
- Existing 45 second on-demand idle keepalive remains unchanged.
- The plan must fit the current recorder/transcription architecture rather than redesigning stream ownership.

## Success Metrics / Guardrails

- Primary guardrail: first-word retention improves in immediate press-and-speak manual tests while the warm stream is open.
- Regression guardrail: no duplicated leading phrase appears in manual transcripts or recorder-focused tests.
- Stability guardrail: no observable new clipping, pause instability, or recording-state confusion appears in the current push-to-talk flow.
- Scope guardrail: no product-facing settings, defaults, or microphone mode semantics change in this release.

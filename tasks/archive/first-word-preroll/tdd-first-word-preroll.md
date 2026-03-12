# TDD: Improve First-Word Capture with Recorder Pre-Roll

## Plain-Language Summary

The recorder already listens to microphone audio before a user starts an on-demand recording. This change makes the recorder remember a short recent slice of that audio and copy it into the new recording when `Start` happens. The buffer lives inside the recorder worker, uses the same 16 kHz audio format that transcription already expects, and leaves the rest of the app’s settings and microphone mode behavior alone.

## Technical Summary

Implement a bounded recorder-worker pre-roll buffer in `src-tauri/src/audio_toolkit/audio/recorder.rs` that stores the most recent resampled 16 kHz samples before VAD filtering. On `Cmd::Start`, clear the current `processed_samples`, copy the current pre-roll contents into it, reset per-recording cursors and flags, retain existing VAD reset behavior, and keep the current 350 ms startup passthrough for post-start frames. Preserve `Drain` and `Stop` signatures and semantics so upstream incremental and final transcription continue to consume one linear sample stream.

## Scope Alignment to PRD

- Supports `FR-001` by prepending a bounded recent audio slice at recording start.
- Supports `FR-002` by making the change internal to the recorder worker with no settings changes.
- Supports `FR-003` by preserving linear `processed_samples`, `drain_cursor`, and `Stop` behavior.
- Supports `FR-004` by retaining current startup passthrough and VAD settings in v1.
- Supports `FR-005` by documenting long-idle closed-stream misses as out of scope and keeping `AudioRecordingManager` stream lifecycle unchanged.

## Current Technical Diagnosis

- `run_consumer` in `recorder.rs` owns the authoritative speech-rate pipeline: raw device samples feed `FrameResampler`, then `handle_frame` applies startup passthrough and VAD gating into `processed_samples`.
- `Cmd::Start` currently clears `processed_samples`, resets cursors and pause flags, resets the visualizer and VAD state, and starts a fresh post-start passthrough window.
- `Drain` slices from `drain_cursor..processed_samples.len()` and uses `saw_pause_since_last_drain` to guide incremental chunking in `transcription.rs`.
- `SmoothedVad` already maintains its own frame prefill, but only emits it once voice onset is detected; that does not guarantee recovery of speech that begins before `Start`.
- `AudioRecordingManager` prewarms the microphone stream in on-demand mode and closes it only after a 45 second idle timer, so recorder-local pre-roll can help only while that stream remains open.

## Architecture / Approach

### Recorder worker changes

- Add a fixed-size pre-roll sample buffer inside `run_consumer`, preferably `VecDeque<f32>` capped by sample count.
- Define an internal pre-roll duration constant of 500 ms at 16 kHz, which equals 8,000 samples.
- Feed the pre-roll buffer from each resampled frame before any VAD filtering or `recording` gate is applied.
- Trim from the front whenever the buffer exceeds the configured maximum sample count.

### Command behavior

- `Cmd::Start`
  - Clear `processed_samples`.
  - Copy the current pre-roll buffer into `processed_samples`.
  - Reset `drain_cursor`, silence tracking, pause flags, and startup passthrough counter.
  - Reset the visualizer and VAD as today.
  - Keep recording enabled so new frames continue through the current pipeline.
- `Cmd::Drain`
  - No interface change.
  - Continue returning only the delta after `drain_cursor`; because pre-roll is copied once at `Start`, it will appear only in the first post-start drain unless later drains include genuinely new samples.
- `Cmd::Stop`
  - No interface change.
  - Continue finishing the resampler, flushing trailing frames into the current recording, and returning the full accumulated sample stream once.

### Testing seam

- Prefer extracting the pre-roll append/trim and start-seeding logic into small helper functions or a worker-state struct so unit tests can verify behavior without a live `cpal` input device.
- If full extraction is too disruptive, add focused tests around new helper functions that own pre-roll state transitions and `drain_cursor` semantics.

## System Boundaries / Source of Truth

- Source of truth for recent microphone history in this feature is the new recorder-worker pre-roll buffer in `recorder.rs`.
- Source of truth for the current recording remains `processed_samples` in `recorder.rs`.
- Source of truth for microphone lifecycle remains `AudioRecordingManager` in `src-tauri/src/managers/audio.rs`; this plan intentionally does not move or widen that responsibility.
- Source of truth for VAD behavior remains `SmoothedVad` and `SileroVad`; the change only alters what gets prepended at recording start.

## Dependencies

- `cpal` input stream behavior remains unchanged; the existing worker still depends on an already-open stream in on-demand warm mode.
- `rubato` resampling remains unchanged and continues to define frame timing into the speech-rate pipeline.
- `SmoothedVad` reset and onset behavior remain unchanged in v1.
- Incremental transcription in `transcription.rs` depends on unchanged `DrainResult` semantics.

## Route / API / Public Interface Changes

- No Tauri command changes.
- No frontend API changes.
- No public settings or schema changes.
- No expected changes to `AudioRecorder` public method signatures.

## Data Model / Schema / Storage Changes

- No persisted schema changes.
- No settings JSON changes.
- One in-memory recorder-worker structure is added for bounded pre-roll sample retention.

## Technical Requirements (`TDR-*`)

### TDR-001 Pre-roll must be captured before VAD gating

The recorder must populate pre-roll from the resampled 16 kHz frame stream before `handle_frame` applies VAD filtering, so speech that began before `Start` can be recovered regardless of VAD onset timing.

### TDR-002 Pre-roll must be bounded by sample count

The recorder must retain only a fixed maximum duration of recent samples and must not allow pre-roll memory to grow unbounded across idle listening.

### TDR-003 Start must seed exactly one linear recording

On `Cmd::Start`, the recorder must prepend the current pre-roll contents exactly once to a newly reset `processed_samples` buffer and then continue appending new speech samples in order.

### TDR-004 Drain and stop semantics must remain stable

`Drain` must continue to emit only the not-yet-drained suffix of the current recording, and `Stop` must continue to return the full current recording without duplicating pre-roll or altering the flush contract.

### TDR-005 Existing VAD and startup passthrough defaults remain in place for v1

The first implementation pass must keep the current VAD thresholding and 350 ms startup passthrough unless verification proves a targeted follow-up is required.

### TDR-006 Long-idle closed-stream handling remains out of scope

The implementation must not modify `AudioRecordingManager` keepalive timing or warm-stream lifecycle in this plan, and tests/docs must treat that case as deferred.

### TDR-007 Recorder behavior must gain focused regression coverage

The change must include recorder-focused automated tests covering first-word capture around `Start`, bounded pre-roll retention, per-start reset semantics, and no duplication across multiple drains.

## Ingestion / Backfill / Migration / Rollout Plan

- No data migration or backfill is required.
- Rollout is a standard code deployment with no feature flag for v1.
- Release notes, if any, can describe improved first-word reliability in on-demand transcription without mentioning new configuration.
- If regressions appear, rollback is a normal code revert because no persisted state changes are introduced.

## Failure Modes / Recovery / Rollback

- Failure mode: pre-roll is copied more than once, causing duplicated opening audio.
  - Recovery: automated drain/start tests should catch this before merge; rollback is code revert.
- Failure mode: pre-roll is fed after VAD, leaving first-word misses unresolved.
  - Recovery: recorder tests and manual keydown scenarios should detect no improvement; fix is to move buffer feed to pre-VAD position.
- Failure mode: added buffering changes pause detection or chunk timing noticeably.
  - Recovery: manual and automated verification should compare pause signaling and incremental chunk behavior; revert if regression is material.
- Failure mode: very-long-idle cases still miss first words because the stream is closed.
  - Recovery: document as expected for this scoped change and handle in a separate stream-lifecycle plan if needed.

## Operational Readiness

- No new secrets, services, or environment changes.
- No new background jobs or lifecycle timers.
- Logging can remain as-is unless a small debug log is useful during local verification.
- This is safe to ship without frontend rollout coordination because public interfaces do not change.

## Verification and Test Strategy

### Automated coverage

- Add unit coverage in or near `recorder.rs` for:
  - speech beginning slightly before `Start` is present after seeding the recording
  - pre-roll is capped to the configured duration
  - a new `Start` resets previous recording state but prepends only the current recent buffer
  - repeated `Drain` calls after one `Start` do not duplicate the prepended audio
- If helper extraction is introduced, test helper logic directly at the sample-buffer level to avoid device dependencies.

### Manual validation

- Immediate press-and-speak in on-demand mode while the microphone stream is already open
- First utterance after a short idle that is still within the 45 second keepalive window
- Short utterance with a quiet first word
- Push-to-talk press/release flow with audio feedback enabled
- Push-to-talk press/release flow with audio feedback disabled

### Exit criteria

- First-word retention improves reliably for the warm-stream keydown case.
- No duplicate leading audio appears in recorder outputs or transcript behavior.
- No noticeable pause-handling or VAD stability regression is observed.
- Long-idle closed-stream misses remain documented as out of scope rather than partially “fixed.”

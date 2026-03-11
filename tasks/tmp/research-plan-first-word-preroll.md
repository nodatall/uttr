# Research Memo: Improve First-Word Capture with Recorder Pre-Roll

## Research Agenda

### Locked planning intake

- Goal: reduce missed first words in on-demand transcription by prepending a short slice of recent microphone audio when recording starts, without changing default microphone mode or user-facing settings.
- Context: the current recorder worker already resamples audio to 16 kHz, applies startup passthrough and VAD gating, supports incremental `Drain` calls, and on-demand mode keeps the stream warm for 45 seconds before closing it.
- Constraints: keep `push_to_talk: true` and `always_on_microphone: false` as defaults, keep the 45 second on-demand keepalive unchanged, keep `Drain`/`Stop` semantics stable, and do not change VAD thresholds unless testing proves the pre-roll fix is insufficient.
- Done when: `Cmd::Start` seeds the current recording with a capped recent-audio buffer, first-word capture at keydown is materially improved while the stream is already open, drains do not duplicate pre-roll, and long-idle closed-stream misses remain explicitly out of scope for this pass.

### Main research questions

1. Where in the current audio pipeline should pre-roll be captured so it preserves speech that starts before `Cmd::Start` and is not blocked by VAD onset behavior?
2. What data structure and ownership model best fit a fixed-size rolling buffer inside the existing recorder worker without changing external recorder APIs?
3. Which existing runtime contracts would be at risk from adding pre-roll, especially `Drain`, `Stop`, startup passthrough, and on-demand stream lifecycle behavior?

### Highest-risk unknowns

- Whether pre-roll should be fed before or after VAD in the existing worker loop.
- Whether `processed_samples` and `drain_cursor` semantics can remain linear after prepending buffered audio.
- Whether the existing `SmoothedVad` prefill and recorder startup passthrough already overlap enough to create duplicate leading audio.
- Whether long-idle failures are caused by recorder startup timing or by the on-demand stream being fully closed.

### Research buckets covered

- Core technical approach and architecture patterns
- APIs, interfaces, schemas, and storage constraints
- Performance, limits, and runtime behavior
- Rollout, rollback, and recovery behavior
- Testing, verification, and failure handling

## Sources Reviewed

### Local primary sources

1. `src-tauri/src/audio_toolkit/audio/recorder.rs`
   - Current worker loop, `Cmd::Start` / `Drain` / `Stop` semantics, `processed_samples` ownership, and startup passthrough logic.
2. `src-tauri/src/audio_toolkit/vad/smoothed.rs`
   - Existing VAD-side prefill, onset gating, hangover handling, and reset behavior.
3. `src-tauri/src/managers/audio.rs`
   - On-demand stream prewarm, 45 second keepalive, `try_start_recording`, `drain_recording_delta`, and stop lifecycle.
4. `src-tauri/src/managers/transcription.rs`
   - Incremental transcription worker assumptions about `DrainResult.samples`, `total_speech_samples`, and pause handling.
5. `src-tauri/src/audio_toolkit/audio/resampler.rs`
   - Resampler emission boundaries and how 30 ms speech-rate frames are produced before recorder-side gating.
6. `src-tauri/src/settings.rs`
   - Existing settings schema and defaults confirming this plan must not introduce a new setting in v1.
7. `src-tauri/resources/default_settings.json`
   - Current default settings payload confirming `push_to_talk: true` and no default `always_on_microphone` override.

### External primary references

8. Rust standard library `VecDeque` documentation (`doc.rust-lang.org`)
   - Confirms `VecDeque` is appropriate for bounded front-pop/back-push ring behavior without manual shifting.
9. `cpal` documentation on input stream creation and playback (`docs.rs/cpal`)
   - Confirms the stream callback keeps producing data after `build_input_stream` + `play`, which matches the existing always-open / warm-on-demand model.
10. `cpal` documentation for supported input configs (`docs.rs/cpal`)
   - Supports the existing recorder design that chooses or falls back to a compatible device config before starting the worker thread.
11. `rubato` `FftFixedIn` documentation (`docs.rs/rubato`)
   - Confirms the recorder’s resampler is chunk-based and should continue to emit speech-rate frames before any new pre-roll buffering logic.

## Research Passes

### Pass 1: repo architecture and current contracts

- The recorder worker is the right insertion point because it already owns the resampled frame stream and the only authoritative linear `processed_samples` buffer.
- `Cmd::Start` currently clears `processed_samples`, resets cursors/state, resets VAD, and enables a 350 ms startup passthrough. That gives a clean point to copy a pre-roll buffer into the current recording without changing manager or coordinator APIs.
- `Drain` returns only the slice from `drain_cursor` onward. This means pre-roll duplication can be avoided if the pre-roll is copied into `processed_samples` exactly once at `Start` and `drain_cursor` is reset to zero there, then advanced normally.
- The current on-demand warm-stream behavior is separate from recording lifecycle. The 45 second idle keepalive means pre-roll can only help when the stream is still open and frames are already being processed in the worker.

### Pass 2: data-structure and pipeline implications

- A recorder-local `VecDeque<f32>` is the simplest bounded structure for a fixed sample-count pre-roll buffer. The worker already runs single-threaded around the consumer loop, so no extra synchronization is needed.
- The pre-roll buffer should be fed from the resampled 16 kHz frame stream before VAD filtering. If it is fed after VAD, quiet or early syllables can still be lost because `SmoothedVad` may return `Noise` until onset has stabilized.
- The buffer should store a capped number of speech-rate samples, not raw device-rate chunks. That keeps copy math aligned with `processed_samples`, `Drain`, transcription chunk sizing, and test assertions.
- Existing startup passthrough should be retained for v1. Pre-roll solves the “speech started just before or at keydown” case, while passthrough still reduces the chance that immediately post-start frames are clipped while VAD restabilizes after `reset()`.

### Pass 3: failure-path and verification implications

- Long-idle closed-stream misses remain a lifecycle problem, not a recorder-buffer problem. If the stream is closed, there is no recent audio to prepend.
- `SmoothedVad` already has its own internal prefill buffer, but that buffer is only emitted after speech onset is recognized. Recorder pre-roll and VAD prefill serve different purposes and should not be treated as redundant.
- `Stop` semantics should remain unchanged: flush the resampler tail into the current recording, clear recording state, and return one linear sample stream. The pre-roll buffer should survive across idle listening because that is how the next `Start` recovers just-before-keydown audio.
- Unit tests should target pure worker semantics rather than full device capture. The current code is light on recorder unit coverage, so planning should include extracting or adding test seams around command handling and pre-roll bookkeeping.

## Findings by Bucket

### Core technical approach and architecture patterns

- Adopt a recorder-worker pre-roll buffer that sits after resampling and before VAD gating.
- Seed `processed_samples` from this buffer only when `Cmd::Start` is handled.
- Keep the buffer alive while `recording == false` so on-demand warm-stream listening continues to accumulate recent audio.

### APIs, interfaces, schemas, and storage constraints

- No settings schema change is needed for v1 because pre-roll duration can be an internal constant.
- No public recorder API change is needed if `start`, `drain`, and `stop` keep their current signatures.
- `DrainResult.total_speech_samples` can remain defined as the current length of `processed_samples`; seeding with pre-roll simply means the total includes prepended audio once, which matches the intended linear stream model.

### Performance, limits, and runtime behavior

- A 500 ms pre-roll at 16 kHz is about 8,000 `f32` samples, which is small enough to keep in-memory per recorder worker without meaningful pressure.
- Bounded `VecDeque` retention avoids unbounded growth and avoids repeatedly shifting large vectors.
- Feeding the buffer from already-resampled frames avoids an extra resampling pass and keeps timing consistent with downstream transcription assumptions.

### Rollout, rollback, and recovery behavior

- The change is local enough to ship without a user-facing migration, feature flag, or rollback hook. Reverting should be a code rollback only.
- Because settings and external interfaces do not change, deployment risk is dominated by audio-quality regression rather than data migration risk.
- The main release risk is duplicate leading audio or altered pause detection, so those behaviors need direct verification before merge.

### Testing, verification, and failure handling

- Add recorder-focused unit tests for capped pre-roll size, start-state reset, single-prepend behavior, and no duplication across multiple drains.
- Manual validation must include immediate press-and-speak, first utterance after long idle while still inside keepalive, quiet-first-word phrases, and push-to-talk behavior with audio feedback enabled and disabled.
- If tests show quiet-first-word misses remain after recorder pre-roll, the next follow-up should revisit VAD thresholding or onset rules in a separate scoped change, not expand this plan silently.

## Design-Impacting Findings

1. Pre-roll must be buffered before VAD, not after it, or the change fails the core requirement of rescuing speech that begins before VAD onset stabilizes.
2. Pre-roll should live in speech-rate samples inside the recorder worker, because that is the narrowest place where timing, command handling, and drain semantics already converge.
3. Keeping the existing 350 ms startup passthrough in v1 is the lower-risk choice; removing or shortening it should be a follow-up optimization only after regression testing proves the pre-roll alone is sufficient.
4. The plan should explicitly defer long-idle closed-stream misses, because those require stream lifecycle changes in `AudioRecordingManager`, which would widen scope beyond the chosen recorder-only fix.

## Alternatives Considered

### Alternative: widen scope to keep the stream open longer or permanently

- Rejected for this plan because it changes resource/privacy behavior and creates a larger operational regression surface than the recorder-only fix.

### Alternative: rely only on `SmoothedVad` prefill or tune VAD thresholds

- Rejected for v1 because VAD-side prefill still depends on speech onset detection and does not guarantee recovery of speech that begins before `Start`.

### Alternative: remove startup passthrough as soon as pre-roll is added

- Rejected for v1 because it introduces an avoidable second variable into first-word regression testing.

## Design Decisions Adopted into the Plan

- Plan key: `first-word-preroll`
- Default pre-roll duration: 500 ms
- Buffer type: fixed-capacity sample-count ring/deque in the recorder worker
- Buffer feed point: resampled 16 kHz frame stream before VAD filtering
- `Cmd::Start`: clear `processed_samples`, copy current pre-roll contents into it, reset cursors/state, retain current VAD reset and 350 ms passthrough behavior
- `Drain` and `Stop`: unchanged external semantics
- Long-idle closed-stream misses: explicitly deferred and documented as out of scope

## Remaining Risks and Unknowns

- The worker may need a small test-only seam to make command and frame processing unit-testable without a live microphone device.
- There is some overlap between recorder pre-roll and VAD-side prefill; tests need to verify this does not create duplicated leading context once speech actually starts.
- Quiet first syllables may still underperform if the underlying detector threshold is too aggressive, but that is not enough reason to widen scope before testing the pre-roll change itself.

## Completion Check

- At least 5 substantive source reviews: satisfied
- At least 3 distinct research questions answered: satisfied
- At least 4 applicable buckets reviewed: satisfied
- At least 2 follow-up passes after the initial source pass: satisfied
- At least 3 design-impacting findings recorded: satisfied

## Research Summary

The best design is a recorder-local, bounded 500 ms pre-roll buffer populated from the resampled 16 kHz frame stream before VAD gating. On `Cmd::Start`, the worker should seed `processed_samples` with that recent audio and then continue using the existing startup passthrough and VAD pipeline. This keeps recorder APIs, settings defaults, and on-demand keepalive behavior unchanged while directly addressing the first-word loss that happens when speech starts at or just before keydown while the stream is already open.

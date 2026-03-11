See `skills/shared/references/execution/task-management.md` for execution workflow and review guidelines.

# Improve First-Word Capture with Recorder Pre-Roll

## Scope Summary

- Add a bounded recorder-worker pre-roll buffer so `Start` prepends recent audio that was captured just before keydown.
- Preserve current push-to-talk defaults, on-demand keepalive behavior, and recorder public interfaces.
- Highest-risk concerns are duplicate leading audio, accidental drain regression, and hidden coupling with VAD startup behavior.

## Relevant Files

- `src-tauri/src/audio_toolkit/audio/recorder.rs` - Recorder worker, command handling, startup passthrough, and the new pre-roll buffer.
- `src-tauri/src/audio_toolkit/vad/smoothed.rs` - Existing VAD-side prefill behavior that must remain compatible with recorder pre-roll.
- `src-tauri/src/managers/audio.rs` - On-demand warm-stream lifecycle and the explicit out-of-scope 45 second keepalive behavior.
- `src-tauri/src/managers/transcription.rs` - Incremental drain consumer that depends on stable `DrainResult` semantics.
- `src-tauri/src/audio_toolkit/audio/resampler.rs` - Resampled frame production that defines the right insertion point for pre-roll buffering.
- `src-tauri/src/settings.rs` - Confirms no settings schema or defaults changes are introduced.
- `src-tauri/resources/default_settings.json` - Confirms default settings remain unchanged.

## Task Ordering Notes

- Implement recorder-local buffering before any test adjustments so the tests can reflect the final state model rather than a speculative helper design.
- Keep manager lifecycle changes out of scope; verification should cover the warm-stream case explicitly and document the long-idle deferred case.
- Run recorder-focused automated tests before any broader app tests so regressions in drain semantics are isolated quickly.

## Tasks

- [x] 1.0 Add bounded recorder pre-roll buffering
  - covers_prd: `FR-001`, `FR-002`, `FR-003`
  - covers_tdd: `TDR-001`, `TDR-002`, `TDR-003`, `TDR-005`
  - [x] 1.1 Add recorder-worker state for capped pre-roll samples at 16 kHz
    - covers_prd: `FR-001`, `FR-002`
    - covers_tdd: `TDR-001`, `TDR-002`
    - output: `src-tauri/src/audio_toolkit/audio/recorder.rs`
    - verify: `cargo test --manifest-path src-tauri/Cargo.toml recorder`
    - done_when: The recorder worker continuously stores only the most recent configured speech-rate samples before VAD filtering while idle or recording.
  - [x] 1.2 Seed new recordings from the current pre-roll buffer on `Cmd::Start`
    - covers_prd: `FR-001`, `FR-003`
    - covers_tdd: `TDR-003`, `TDR-005`
    - output: `src-tauri/src/audio_toolkit/audio/recorder.rs`
    - verify: `cargo test --manifest-path src-tauri/Cargo.toml recorder`
    - done_when: Starting a recording clears prior recording state, prepends the current pre-roll once, resets cursors and pause flags, and retains existing VAD reset plus 350 ms startup passthrough behavior.

- [ ] 2.0 Preserve recorder output semantics and regression-proof the change
  - covers_prd: `FR-003`, `FR-004`, `FR-005`
  - covers_tdd: `TDR-004`, `TDR-006`, `TDR-007`
  - [x] 2.1 Add automated coverage for pre-roll capping, start reset, and no duplicate drains
    - covers_prd: `FR-003`, `FR-004`
    - covers_tdd: `TDR-004`, `TDR-007`
    - output: `src-tauri/src/audio_toolkit/audio/recorder.rs`
    - verify: `cargo test --manifest-path src-tauri/Cargo.toml recorder`
    - done_when: Tests fail if pre-roll grows unbounded, carries old recording state into a new start, or is emitted more than once across drains.
  - [ ] 2.2 Validate upstream assumptions and document the explicit deferred case
    - covers_prd: `FR-004`, `FR-005`
    - covers_tdd: `TDR-004`, `TDR-006`, `TDR-007`
    - output: `src-tauri/src/audio_toolkit/audio/recorder.rs`
    - verify: `cargo test --manifest-path src-tauri/Cargo.toml`
    - done_when: Recorder outputs remain compatible with incremental transcription assumptions, and the completed implementation keeps long-idle closed-stream misses explicitly deferred instead of changing manager lifecycle behavior.

- [ ] 3.0 Run focused verification for user-visible recording behavior
  - covers_prd: `FR-001`, `FR-004`
  - covers_tdd: `TDR-005`, `TDR-007`
  - [ ] 3.1 Execute recorder-focused automated tests and warm-stream manual checks
    - covers_prd: `FR-001`, `FR-004`
    - covers_tdd: `TDR-005`, `TDR-007`
    - output: `src-tauri/src/audio_toolkit/audio/recorder.rs`
    - verify: `cargo test --manifest-path src-tauri/Cargo.toml recorder`
    - done_when: Automated tests pass and manual scenarios confirm first-word improvement for immediate press-and-speak without noticeable pause or duplication regressions.

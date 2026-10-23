# No-speech detection implementation notes

Checked locally on 2026-10-23. These notes support the [execution plan](execution-plan-no-speech-detection.md); the plan controls scope. Implementation is present and native calibration is in progress. Rejection and dictation phrase-filter retirement remain disabled until acceptance passes.

The user explicitly requested no new tests. Add or change no automated test code, test cases, test fixtures, spies, replay harnesses, or smoke scripts. Use existing tools and tests, source review, and manual native verification. Do not create disposable test scripts as a workaround. Record gaps honestly; the required speech-preservation and native acceptance checks still apply.

## Incident and baseline

The October 23 event at approximately 13:08:43–44 Pacific recorded a 119 ms hold, sent 20,000 samples at 16 kHz (1.25 seconds after padding) to Groq `whisper-large-v3`, received four characters in approximately 290 ms, and pasted “Bye.” History item 8455 has raw text “Bye.” and no postprocessing result. Cleanup was disabled and there were no custom words. The artifact originated in transcription, rather than text cleanup.

The saved audio has about 9,920 real leading samples (0.620 seconds, including pre-roll). Whole-buffer RMS is approximately 0.000607 and peak is 0.006378. Existing silence detection recognizes the low-energy recording, but the phrase-specific suppression helper accepts “Bye.” while suppressing “Thank you.” Adding another phrase would leave the same failure mechanism for other text.

Local evidence sources, private and excluded from commits or provider uploads:

- Log: `/Users/fromdarkness/Library/Logs/com.pais.uttr/uttr.log`, approximately lines 4960–5016 at investigation time.
- Recording: `/Users/fromdarkness/Library/Application Support/com.pais.uttr/recordings/uttr-1792786124-e3a93fac-9e7f-47be-958f-835465e7f05c.wav`.
- Existing investigation tools: `agent-scratch/silent-bye-investigation/`. Their compiled binaries are not durable test coverage; reuse only where they exercise the relevant behavior, without writing new tests or replacement harnesses.

Branch `deliver/no-speech-detection` starts from `090f787`. The tree was clean before planning. That commit contains an unrelated marketing Node runtime update already ahead of `origin/main`; preserve it. The clean status baseline is `tasks/tmp/finalization-baseline-no-speech-detection.status`.

## Existing detector and useful measurements

`src-tauri/src/audio_toolkit/vad/silero.rs` obtains the raw `Vad::compute(...).prob` value and discards it after comparing with 0.22. Frames are 480 samples, or 30 ms at 16 kHz. `managers/audio.rs` constructs this inside a smoothed capture detector with prefill and hangover. Those retained frames are not independent proof of speech.

The pinned `vad-rs` revision `88b3a01` exposes a recurrent-state `reset()` method. The current Silero wrapper does not override the trait's no-op reset, and `SmoothedVad::reset` clears its wrapper state without forwarding a reset. Give the new independent scorer an explicit reset; do not silently change existing capture retention or reset behavior as an unrelated repair. Reuse the bundled `resources/models/silero_vad_v4.onnx` and existing dependency.

A direct local replay of the incident through this model produced a maximum raw score of approximately 0.003276 before manager padding, with zero frames above 0.22. Initialization took 44.1 ms and inference approximately 4.0 ms in that run. A padded replay took 21.1 ms to initialize and 6.8 ms to scan, and reached approximately 0.064162. These isolated measurements demonstrate feasibility and padding sensitivity. They are neither an end-to-end latency benchmark nor calibrated confidence values.

The rejection rule uses the maximum score rather than whole-recording average energy, speech fraction, or a minimum duration. Initial silence therefore cannot dilute later speech. Choose the rejection cutoff only on the calibration partition, with a margin below observed positive scores; freeze it before checking held-out sessions. Unseparated or uncertain examples pass. Successful controls support this bounded acceptance set, not a guarantee for every voice or environment. Do not use the private incident as the only negative control.

## Capture and evidence boundaries

Relevant code is under `src-tauri/src/`:

- `audio_toolkit/audio/recorder.rs`, near `start` and the frame handler: the retained buffer begins with 500 ms of raw pre-roll; the first 650 ms bypass capture VAD. Later retention includes smoothing and quiet-energy rescue. `total_speech_samples` measures retained buffer length, not confirmed speech.
- `audio_toolkit/audio/resampler.rs`: both the last native-rate batch and final 30 ms output frame can contain zero padding. Preserve valid-sample metadata through the observer boundary. Score full genuine 480-sample frames chronologically. At dictation completion only, cover a remaining partial frame by appending the final 480 genuine samples as an end-aligned overlapping window, using that dictation's recurrent state. Calibrate this exact sequence and inspect tail handling through existing tools and source review; reset before the next dictation. During recording, incremental requests use completed frame evidence without injecting overlapping observations into the active stream. Fewer than 480 genuine samples or unverifiable valid lengths produce uncertain evidence. This is a model-input requirement, not an added recording-duration limit. Never extend the observation stream with manager padding.
- `managers/audio.rs`: normal stop and borrowed-dictation completion pad short recordings to 1.25 seconds. Observe before these pads and before gain normalization.
- `actions.rs`, near `start_recording` around line 4790: start independent loading alongside microphone capture. The detector queue must be bounded and nonblocking. Overflow, model failure, invalid samples, or unprocessed samples cannot produce a no-speech decision.

Raw offsets and retained-buffer offsets are different: capture filtering can discard audio and smoothing can reintroduce prefill. Carry evidence with retained ranges, or maintain an explicit mapping. Do not infer raw coverage from retained length. An incomplete interval must not be labeled silent. At dispatch use completed evidence already available; do not block on the loader or wait for the worker to catch up. This can let an occasional silent recording proceed, which is preferable to dropping an unexamined word.

`DrainResult` reports a delta and the absolute retained-buffer length; stop returns the full retained buffer, including previously drained data. Preserve correspondence through chunk overlap and fallback. Session-wide speech evidence must survive drains, so a silent tail cannot erase an earlier word.

Use the existing operation identity/cancellation generation to ignore stale detector results. A cached model may be reused, but recurrent state and evidence belong to a single dictation. Reset on each new operation. Quick dictation while a meeting owns the microphone rebinds and drains an existing recorder rather than issuing its ordinary start; reset at that borrow boundary and restore ownership on stop or cancel. Meeting detector state must not leak into dictation or be reset by it.

## Dispatch and completion

`managers/transcription.rs` routes common raw requests through `transcribe_raw_with_settings`, but local incremental requests call `transcribe_raw_local_with_settings` directly. Both paths need the gate before provider calls. The common raw functions also serve other audio sources; carry explicit dictation evidence/context rather than making every caller subject to the new policy.

Incremental processing starts after a 10-second warmup, builds roughly 10-second chunks with 1.5-second overlap, and has pause/length flush paths. Final tails use the retained-buffer cursor minus overlap. Advance consumed-audio position independently from successful request count when skipping a chunk. Otherwise skipped silence can be resent or cause an empty assembly to trigger a full-recording request. Check leading silence followed by speech across these boundaries in the native app.

`actions.rs` finalization around line 4095 chooses incremental output versus a full pass and performs the downstream paste/history work. A session confidently containing no speech must finish without dispatch/output/history while still using operation-aware overlay cleanup. Mixed sessions keep recognized speech. Unknown evidence continues to transcription without phrase suppression after the replacement is activated.

The existing `should_suppress_silence_hallucination` helper in `managers/transcription.rs` combines three policies: low-energy rejection of “thank you,” “thanks for watching,” and “thank you for watching”; unconditional rejection of two normalized Amara subtitle-credit phrases; and near-silent punctuation-only rejection. `transcribe_with_source` applies it after transcription, and full-system meeting chunks also use that method. Retire both phrase-list branches for microphone dictation, including the uncertain-evidence path, when activating the detector. Keep punctuation-only handling and non-dictation behavior intact. Use explicit dictation context so a borrowed microphone's source label or missing evidence cannot select the wrong policy. Do not delete shared helpers still required by other sources or audio gain handling.

Run existing suppression-policy tests unchanged and manually verify the revised dictation path retains formerly blocked phrases, including a genuine quoted subtitle credit. Review non-dictation and punctuation behavior for unintended changes. Include a real quiet “thank you” in the local speech-preservation recordings. Activate and roll back detector gating and phrase-filter retirement together, so the ordinary-use state remains coherent during validation.

## Validation limitations and required proof

The checked-in `src-tauri/test-fixtures/audio/sample.wav` is a 0.6-second 880 Hz tone, not speech. The existing `quiet_voice` constant-amplitude fixture proves an energy fallback only. A local sandboxed `say` probe produced near-empty zeros and is invalid. None establishes quiet-word preservation.

Use consented human recordings with source, microphone, intended words, and labels, kept locally outside the test suite and commits. Supplemental attenuation variants can check gain sensitivity but cannot replace natural quiet replies. Separate calibration and held-out recordings by take/session to avoid treating copies as independent evidence. Obtain the two microphone sources in the plan; if unavailable, record the blocker rather than declaring coverage.

The release smoke script `scripts/release-transcribe-smoke.mjs` currently injects its fixture at stop in `managers/audio.rs`, bypassing capture VAD. It also enforces a two-second hold and expects successful transcription/paste/history. Its preflight ends before running-app and accessibility checks. Leave this harness unchanged. Use direct native checks for silence rejection and subsecond capture; neither this smoke test nor a finished-WAV replay proves those paths.

Use existing logs, local audio inspection, and observed paste/history outcomes to check rejection and word preservation. A gate pass alone is insufficient. For private recordings, use existing local diagnostics without provider submission. If available tooling cannot establish a required acceptance result, report the verification blocker rather than create a new test harness or claim proof. Check cold loading, cancellation and rapid restart, leading silence, incremental paths, and borrowed ownership manually. Use existing tests and source review for failure paths that existing tools cannot exercise, clearly marking those as not dynamically verified. If existing capture loses a required word, report the conflict without broadening into capture redesign.

Required commands after relevant code changes: focused Rust tests, `cd src-tauri && cargo test`, `bun run tauri:build:fast`, and `bun run test:e2e:release-transcribe -- --preflight-only`; then full smoke/native verification when permitted. If JS/TS changes, run `bun run build` and `bun run lint` as required by AGENTS.md. A build or preflight is not native-flow proof.

At investigation time the running Uttr app was an older debug bundle launched October 20, not a rebuilt candidate. Verify process/bundle identity before claiming a native check. Coordinate any app replacement that would interrupt active dictation or meetings. Record overlay recovery through the actual native flow with a screenshot or equivalent visual evidence.

Enable rejection in the isolated acceptance candidate so native negative flows can be tested; keep it disabled for ordinary use until acceptance passes, without adding a user-facing setting. Compare baseline/candidate runs on the same machine and microphone, with cold and warm model states, 119 ms taps, short words, and longer incremental recordings. Report sample count, median and p95 stop-to-result time, detector initialization, evidence availability at dispatch, and observed rejection rates. The saved incident and silent controls must reject when evidence is complete and ready. Delayed loading, backlog, and failure checks instead must demonstrate the specified pass-through fallback; explicitly report any cold taps that still reach ASR. Separately verify that capture never waits on model loading and release adds no fixed delay; the earlier 4 ms replay does not establish those properties.

## Implementation and verification progress

The independent observer runs on a bounded worker queue, loads the existing model on press, resets recurrent state per operation, and observes capture PCM with valid-sample metadata. Dispatch uses explicit dictation identity and retained-range evidence. Incremental skips advance the consumed cursor and carry a merged rejection ledger into overlap, tail, and full-pass fallback. Unknown evidence passes through. The single cutoff constant currently remains `None`, which keeps both rejection and phrase-filter retirement inactive during calibration.

`test_disposition: no_test` applies throughout: the user explicitly prohibited new or changed tests, fixtures, and harnesses. Existing recorder, suppression, and incremental-finalization tests passed unchanged. The full existing Rust suite passed (155 tests), `bun run tauri:build:fast` passed, and `bun run test:e2e:release-transcribe -- --preflight-only` passed. These do not establish native speech preservation or silent rejection.

Both baseline and candidate are run directly by Codex from repository-built app bundles, as requested. The unchanged baseline app signature verified and the user completed the requested quiet replies, leading silence, and silent taps on DJI MIC MINI. Baseline content-free timing is retained locally in `agent-scratch/no-speech-baseline-timing.log`; silent taps of 116, 127, and 140 ms still issued ASR requests. A candidate is running with content-free diagnostics in `agent-scratch/no-speech-candidate-calibration.log`. Human calibration, held-out acceptance, activation, and final review remain pending.

Debug app bundling initially failed only at updater-archive signing after building and signing the app. Bundling with the command-only override `--config '{"bundle":{"createUpdaterArtifacts":false}}'` succeeded; no tracked signing or bundle configuration changed.

### DJI calibration, 2026-10-23 16:47 Pacific

The user confirmed the requested sequence worked except the last silent quick tap pasted “thank you.” Rejection was disabled throughout. The nine consecutive labeled operations are from the candidate launched at 16:46 Pacific; later unrelated dictation is excluded. Content-free diagnostics are saved locally in `agent-scratch/no-speech-dji-calibration.log`.

| Operation | Intended control | Maximum raw score | Hold ms |
| --- | --- | ---: | ---: |
| 1 | Quiet yes, immediate release | 0.752774 | 932 |
| 2 | Quiet no, immediate release | 0.091510 | 1066 |
| 3 | Quiet bye, immediate release | 0.178816 | 1057 |
| 4 | Quiet thank you, immediate release | 0.409982 | 1207 |
| 5 | Whispered yes | 0.104455 | 1073 |
| 6 | Silence then yes | 0.159173 | 2246 |
| 7 | Silence then no | 0.386747 | 5218 |
| 8 | Silent tap | 0.004686 | 131 |
| 9 | Silent tap, hallucinated thank you | 0.011937 | 152 |

All nine analyses completed. Whole-recording evidence was briefly unavailable at the first inspection for operations 4 and 5 and passed through; it was ready before their full-pass dispatch. Cold detector initialization took 30.812 ms on its separate worker. The whispered take's retained-request score was 0.077380, still above either silent tap. A prospective cutoff must preserve that lower retained-range value, not just the whole-session maximum. Built-in calibration is pending; no cutoff has been selected or enabled.

The requested 3- and 5-second silence controls were not precisely timed: operation 6 lasted only 2.246 seconds in total. These takes prove speech after some silence, but do not establish both exact leading-silence durations. Repeat timed leading-silence controls during held-out acceptance.

The original incident WAV is no longer present in normal history storage after subsequent recordings and the configured 20-entry retention. Its earlier raw/padded model measurements remain recorded above, but an exact replay through the newly implemented observer cannot now be performed from that file. The new labeled 152 ms silent tap reproduces a real hallucinated phrase through the production capture path and provides a fresh negative control. Do not claim a new-observer replay of the deleted incident.

# No-speech detection implementation notes

Checked locally on 2026-10-23. These notes support the [execution plan](execution-plan-no-speech-detection.md); the plan controls scope. Both DJI acceptance candidates failed. The corrected scorer with a frozen 0.08 cutoff allowed longer silent recordings to reach transcription. Rejection and dictation phrase-filter retirement are disabled together again. The user has stopped further recording requests; continue engineering and review using existing evidence, without requesting more takes. Ordinary-use activation remains unverified.

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
- `audio_toolkit/audio/resampler.rs`: both the last native-rate batch and final 30 ms output frame can contain zero padding. Preserve valid-sample metadata through the observer boundary. The independent scorer will assemble chronological 512-sample windows from genuine PCM, following the model's trained frame size. At completion, copy only the unexamined remainder into one zero-filled 512-sample model-input window; score it once on the existing recurrent state and assign evidence only to the real remainder. Those model-input zeros do not enter raw/retained audio or count as examined samples. Do not replay earlier PCM or score manager padding. During recording, incremental requests use only ready full-frame evidence. Fewer than 512 genuine samples in the whole session or unverifiable valid lengths produce uncertain evidence. This is a model-input requirement, not an added recording-duration limit. Keep capture's 480-sample frames and its existing retention behavior unchanged. Reset model state before the next dictation. Recalibrate this exact sequence before held-out acceptance.
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

Use consented human recordings with source, microphone, intended words, and labels, kept locally outside the test suite and commits. Supplemental attenuation variants can check gain sensitivity but cannot replace natural quiet replies. Separate calibration and held-out recordings by take/session to avoid treating copies as independent evidence. The user explicitly limited verification to DJI MIC MINI on October 23; do not request built-in microphone recordings or claim coverage for other microphones.

The release smoke script `scripts/release-transcribe-smoke.mjs` currently injects its fixture at stop in `managers/audio.rs`, bypassing capture VAD. It also enforces a two-second hold and expects successful transcription/paste/history. Its preflight ends before running-app and accessibility checks. Leave this harness unchanged. Use direct native checks for silence rejection and subsecond capture; neither this smoke test nor a finished-WAV replay proves those paths.

Use existing logs, local audio inspection, and observed paste/history outcomes to check rejection and word preservation. A gate pass alone is insufficient. For private recordings, use existing local diagnostics without provider submission. If available tooling cannot establish a required acceptance result, report the verification blocker rather than create a new test harness or claim proof. Check cold loading, cancellation and rapid restart, leading silence, incremental paths, and borrowed ownership manually. Use existing tests and source review for failure paths that existing tools cannot exercise, clearly marking those as not dynamically verified. If existing capture loses a required word, report the conflict without broadening into capture redesign.

Required commands after relevant code changes: focused Rust tests, `cd src-tauri && cargo test`, `bun run tauri:build:fast`, and `bun run test:e2e:release-transcribe -- --preflight-only`; then full smoke/native verification when permitted. If JS/TS changes, run `bun run build` and `bun run lint` as required by AGENTS.md. A build or preflight is not native-flow proof.

At investigation time the running Uttr app was an older debug bundle launched October 20, not a rebuilt candidate. Verify process/bundle identity before claiming a native check. Coordinate any app replacement that would interrupt active dictation or meetings. Record overlay recovery through the actual native flow with a screenshot or equivalent visual evidence.

Enable rejection in the isolated acceptance candidate so native negative flows can be tested; keep it disabled for ordinary use until acceptance passes, without adding a user-facing setting. Compare baseline/candidate runs on the same machine and microphone, with cold and warm model states, 119 ms taps, short words, and longer incremental recordings. Report sample count, median and p95 stop-to-result time, detector initialization, evidence availability at dispatch, and observed rejection rates. Preserve the original incident's historical score and exact-replay gap: normal history retention removed the WAV, and its old 480-sample score cannot calibrate the corrected 512-sample sequence. Use fresh calibration and separate held-out controls on the exact corrected scorer. Fresh held-out silent controls must reject when evidence is complete and ready. Delayed loading, backlog, and failure checks instead must demonstrate the specified pass-through fallback; explicitly report any cold taps that still reach ASR. Separately verify that capture never waits on model loading and release adds no fixed delay; the earlier 4 ms replay does not establish those properties.

## Implementation and verification progress

The independent observer runs on a bounded worker queue, loads the existing model on press, resets recurrent state per operation, and observes capture PCM with valid-sample metadata. Dispatch uses explicit dictation identity and retained-range evidence. Incremental skips advance the consumed cursor and carry a merged rejection ledger into overlap, tail, and full-pass fallback. Unknown evidence passes through. The single cutoff constant was `None` during calibration, frozen at `Some(0.02)` for failed acceptance, and rolled back to `None` afterward. This disables rejection and restores the phrase filter together.

`test_disposition: no_test` applies throughout: the user explicitly prohibited new or changed tests, fixtures, and harnesses. Existing recorder, suppression, and incremental-finalization tests passed unchanged. The full existing Rust suite passed (155 tests), `bun run tauri:build:fast` passed, and `bun run test:e2e:release-transcribe -- --preflight-only` passed. These do not establish native speech preservation or silent rejection.

Both baseline and candidate are run directly by Codex from repository-built app bundles, as requested. The unchanged baseline app signature verified and the user completed the requested quiet replies, leading silence, and silent taps on DJI MIC MINI. Baseline content-free timing is retained locally in `agent-scratch/no-speech-baseline-timing.log`; silent taps of 116, 127, and 140 ms still issued ASR requests. Initial candidate content-free diagnostics are in `agent-scratch/no-speech-candidate-calibration.log`, with the labeled restarted session in `agent-scratch/no-speech-dji-calibration.log`. Held-out acceptance, ordinary-use activation, and final review remain pending.

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

All nine analyses completed. Whole-recording evidence was briefly unavailable at the first inspection for operations 4 and 5 and passed through; it was ready before their full-pass dispatch. Cold detector initialization took 30.812 ms on its separate worker. The whispered take's retained-request score was 0.077380, still above either silent tap. A prospective cutoff must preserve that lower retained-range value, not just the whole-session maximum. The user subsequently limited verification to DJI MIC MINI. Eight saved control recordings were preserved locally under `agent-scratch/no-speech-calibration/dji/` before history retention could remove them; the first silent take had no history audio because its output was suppressed.

The first candidate's rejection cutoff was frozen at 0.02 before held-out recordings. This exceeded the largest labeled silent-tap maximum (0.011937) and the original incident's recorded raw maximum (0.003276), while staying below the lowest spoken whole-recording maximum (0.091510) and lowest spoken retained-request maximum (0.077380). These measurements apply to the old 480-sample/overlapping-tail sequence only. The corrected scorer requires new calibration and a separately frozen cutoff. Other microphones are unverified.

The requested 3- and 5-second silence controls were not precisely timed: operation 6 lasted only 2.246 seconds in total. These takes prove speech after some silence, but do not establish both exact leading-silence durations. Repeat timed leading-silence controls during held-out acceptance.

The original incident WAV is no longer present in normal history storage after subsequent recordings and the configured 20-entry retention. Its earlier raw/padded model measurements remain recorded above, but an exact replay through the newly implemented observer cannot now be performed from that file. The new labeled 152 ms silent tap reproduces a real hallucinated phrase through the production capture path and provides a fresh negative control. Do not claim a new-observer replay of the deleted incident.

### Borrowed finalization repair

Source-path inspection found a false-rejection risk after incremental drains during a borrowed microphone session. The pre-existing closing boundary returned only the last delta, whereas the new request gate and rejection ledger interpreted stop audio as starting at the beginning of dictation. A later spoken tail could therefore be compared with or removed as earlier silence. The repair records the borrowed segment's retained start at observer attachment and returns that full slice at its closing boundary, even if analysis became Unknown. It preserves meeting PCM, ordinary delta drains, ordinary Stop, and unobserved/Ask Selection paths, without a second PCM accumulator. All six existing recorder tests and all 155 existing Rust tests passed after the repair. The full suite initially encountered a sandbox-only localhost bind restriction; the unchanged suite passed with host permission. Existing test modules were compared with the baseline and remain unchanged. Native borrowed-session acceptance is pending. No tests were added.

### Preliminary latency comparison

Ten saved baseline takes on DJI MIC MINI had median/p95 start-handler times of 35.5/47 ms, stop-handler times of 37.5/103 ms, and provider-stage times of 308/333 ms. The nine labeled monitor-mode calibration takes had corresponding times of 35/42 ms, 41/85 ms, and 290/445 ms. P95 uses the nearest-rank method and equals the maximum in these small samples.

The sum of measured stop-handler and provider stages was median/p95 342.5/422 ms for baseline and 331/489 ms for calibration. These stage sums exclude async scheduling and paste; they are not exact stop-to-paste measurements. The samples show no measured startup regression, but do not isolate a causal detector overhead or support a precise latency promise. Enabled silent rejections and native acceptance remain pending.

### Enabled acceptance candidate

The native fast build and existing transcription preflight passed, and the corrected debug app bundle built with updater artifacts disabled. `codesign --verify --deep --strict` passed. Candidate executable SHA-256: `fa6167569e8a677840fe1084b87a89225000c74d3f11ad5740f5fa73ace3b745`. Codex launched that bundle directly at 17:04 Pacific on October 23; startup confirms DJI MIC MINI at 48 kHz, frontend readiness, and input/shortcut permissions. Its content-free log is `agent-scratch/no-speech-dji-acceptance.log`. Immediately before the held-out set, read-only history metadata showed 77 total rows and latest ID 8513; no transcript text was read for that check.

Held-out sequence requested after cutoff freeze: two silent taps at least one second apart, then separate quiet yes/no/bye/thank-you replies, whispered yes, and timed 3- and 5-second leading silence followed by yes/no. The user instead reported a silent batch that produced “thank you” and, when asked to distinguish spoken controls from silent taps, explicitly answered “Entire batch was silent.” Do not infer positive labels from recording lengths or ASR output. The full existing smoke run, cancellation/borrowed native checks, and final review remain pending.

### Failed acceptance, October 23 at 19:34 Pacific

All 17 operations had complete observer evidence. Operations 1–4 and 13–16 rejected before ASR; operations 5–12 and 17 reached ASR. The user initially labeled the entire batch silent, then listened to operation 5 and confirmed audible speech or background voices. The batch therefore cannot establish an 8/17 silent-rejection rate; individual labels for operations 6–12 remain unverified. The final 157 ms tap (operation 17) remains the reported silent failure: it scored 0.06549862, above the frozen 0.02 cutoff, and ASR returned ten characters, saved history/audio, and pasted “Thank you.” The first cold 215 ms tap scored 0.006860 and rejected; model initialization took 70.513 ms. Missing evidence or loading latency does not explain the final failure.

Nine saved captures from that batch were preserved locally under `agent-scratch/no-speech-calibration/dji-heldout-failed/`. The failed short tap is `uttr-1792809275-adc4ba4f-b680-4a75-bf01-863b175076a0.wav`; after listening to that exact file, the user confirmed only silence or handling noise. The confirmed audible-speech capture is operation 5, `uttr-1792809252-a5a66204-1461-4740-abb8-aecd79f037b2.wav`. No further live recordings have been requested.

The existing `vad-scores` binary produced 0.011040 on the final tap trimmed to its 10,784 real samples and 0.107304 on the padded 20,000 samples. Its original compilation command was recovered read-only from this conversation's saved transcript: it removes an exact-zero suffix, scans chronological 480-sample chunks, and pads only the last partial model-input frame to 480. It reads the saved PCM16 recording, whereas production observes original floats. Production scored 22 chronological frames followed by the end-aligned range 10,304..10,784 on the same recurrent state, repeating 256 already-seen samples. That overlap is proven; its responsibility for the higher production maximum is not yet proven because existing diagnostics do not distinguish chronological and tail maxima. No new replay program was created or compiled.

The same existing tool scored operation 5's trimmed 23,504 samples at 0.969325, with 13 chronological frames above 0.22; production scored 0.955175. The user's subsequent audible-speech confirmation makes this an expected speech detection, not an established classifier error. Do not infer other takes' labels from scores, recording lengths, or ASR text. Raising the cutoff on this failed held-out set is not an accepted repair and could reject previously preserved quiet words.

The next verification step is content-free production diagnostics separating the maximum chronological score from the final overlapping-window score. A high chronological maximum would weaken the tail-repetition explanation; a low chronological maximum followed by a high tail score would support it. Add only that observation first, without changing inference, the cutoff, or capture. Existing saved-WAV tooling cannot expose the exact original-float production state, and no replacement replay harness is authorized.

Pinned `vad-rs` exposes `new`, `compute`, and `reset`, without recurrent-state snapshot/restore or Clone. `compute` forwards variable input lengths without validation; its examples ignore inference errors, so they do not establish which short final fragments the bundled model supports. Do not guess a replacement tail policy from that alone.

The [upstream Silero v4 wrapper](https://github.com/snakers4/silero-vad/blob/v4.0/utils_vad.py) validates a minimum 512-sample input at 16 kHz, recommends trained sizes 512/1024/1536, and zero-pads only the final incomplete input window in its whole-audio scan. Uttr's existing capture wrapper uses 480 samples; this observer inherited that size and was calibrated with it. Neither source establishes arbitrary short-fragment support. A future frame-size or final-window policy change requires new calibration and held-out native verification; the old cutoff's separation cannot be assumed to survive it.

At 19:40 Pacific, Codex closed the failed candidate and launched the signature-verified baseline from `agent-scratch/no-speech-baseline/Uttr.app`; startup and native UI confirm DJI MIC MINI, working shortcuts, and Ready to start. The source cutoff is now `None`. All 155 existing Rust tests, `bun run tauri:build:fast`, and the existing transcription preflight passed after rollback; no test code changed. The bundle under `src-tauri/target/debug/bundle/macos/Uttr.app` is still the failed enabled candidate until explicitly rebuilt; do not relaunch it as ordinary use. Acceptance, final review, and archive remain pending diagnosis and a validated repair.

### Diagnostic follow-up, October 23 at 20:09 Pacific

The observer now logs the chronological maximum before final-window inference, that final window's optional score and status, and its pending real-sample count. Scoring, capture, coverage, cutoff, and phrase policy are unchanged. All 155 existing Rust tests, the native fast build, and transcription preflight passed. No tests, fixtures, or harnesses were added or changed.

The debug app bundle was explicitly rebuilt with updater artifacts disabled and passed `codesign --verify --deep --strict`. Its executable SHA-256 is `f70c61ea16edafce8f83f6a5fc199c055f873ed1659a16844c75d196a7484ad6`. Codex closed the idle baseline and launched this repository bundle directly. Startup confirms DJI MIC MINI, input permission, and initialized shortcuts; native UI shows Ready to start. Content-free output is in `agent-scratch/no-speech-tail-diagnostics.log`. Rejection and dictation phrase-filter retirement remain disabled.

The native UI tool cannot synthesize Fn (`keyNotFound("fn")`), so it did not start a recording. The user attempted the requested six silent quick taps with background voices paused and reported pasted “amen” and “thank you.” Logs contain four actual capture operations at 20:15:36–40 Pacific. Other presses were ignored during processing or cancelled within the existing shortcut debounce; do not count them as analyzed recordings or change shortcut behavior in this task.

| Operation | Highest chronological score | Final-window score | Whole maximum | Evidence |
| --- | ---: | ---: | ---: | --- |
| 1 | 0.010799 | 0.006146 | 0.010799 | Complete, cold init 34.158 ms |
| 2 | 0.011775 | 0.006047 | 0.011775 | Complete |
| 3 | 0.010296 | 0.005837 | 0.010296 | Complete |
| 4 | 0.002407 | 0.002217 | 0.002407 | Complete |

All four whole scores were ready at dispatch and below the frozen 0.02 cutoff. Blocking was intentionally disabled, so all four issued ASR requests; the old phrase filter suppressed the first two, and operations 3/4 pasted 5/10-character results. This batch is consistent with the user's report and would have rejected under the previous enabled gate. It does not reproduce the earlier high-score false detection: every final-window score is lower than its chronological maximum. The earlier operation 17's cause remains unresolved. Do not claim this observation proves or disproves that earlier tail's responsibility.

The two saved diagnostic WAVs are preserved locally in `agent-scratch/no-speech-calibration/dji-tail-diagnostics/`. Existing `vad-scores` reports trimmed/padded maxima 0.014938/0.154047 for operation 3 and 0.003893/0.023497 for operation 4. Their saved retained lengths differ from raw observer coverage (operation 3 saves 9,920 samples versus 10,055 observed), so a saved-file replay is not an exact replay of original-float observer input. The earlier failed tap's existing-tool score remains 0.011040 trimmed and 0.107304 padded. No scoring repair or activation has been made from the current hypothesis.

Source review confirms history saves the audio clone made before provider gain. Operation 17's 4× gain therefore cannot explain the observer-versus-file discrepancy. Its counts fit 8,000 pre-roll samples, five full capture frames, and a last frame containing 384 real samples plus 96 capture-padding samples. This supports shared alignment but does not preserve the missing original floats or establish which window caused its high score. No additional mapping defect was established.

### Scoring consistency correction

Replace the independent observer's inherited 480-sample frames and overlapping end window with upstream-documented 512-sample chronological windows and a single model-only padded final remainder. This corrects the proven duplicated input and follows the documented trained input size; it is not proof of the earlier false positive's cause. Keep rejection and phrase retirement disabled throughout new calibration. Do not reuse the old cutoff as validated evidence or tune it against a held-out batch.

Keep raw offsets and evidence coverage limited to genuine samples; a final model window covers `processed_samples..raw_samples`, never its zero extension. Retained mappings and capture's 480-sample framing remain unchanged. Preserve a separate bookkeeping bound for retained capture blocks rather than accidentally shrinking that limit when changing the model frame size. Finish diagnostics must distinguish full-frame and final-remainder scores. Existing WAV tooling uses 480-sample windows and cannot validate this new sequence. Use unchanged Rust tests/build/preflight, source review, and fresh DJI native calibration and held-out checks; create no replacement replay tool or tests.

The correction is implemented in `speech_observer.rs`: consecutive 512-sample full windows, one pending-only model input at finish, genuine-only final coverage, and separate retained/score bookkeeping limits. Both whole and retained-range evidence stay Unknown below 512 genuine session samples. Source review checked exact windows, partial remainder, invalid/incomplete analysis, short sessions, and ordered retained-range lookup. All 155 existing Rust tests, the native fast build, and transcription preflight passed after this change. No tests or harnesses changed. New native calibration, acceptance, and activation remain pending.

Read-only host audio inventory confirms DJI MIC MINI is also the system default input. The unchanged full smoke harness's default-input setting therefore fits the current DJI-only scope; no global microphone setting was changed. This does not itself establish a smoke-test pass.

### Corrected-scorer calibration, October 23 at 20:44 Pacific

The corrected repository bundle passed signature verification and was launched by Codex at 20:43:57 Pacific on DJI MIC MINI. Executable SHA-256: `55dd0cc3fcec742ddc223c4a35b6189914d145474a5887d41ce1999d01b94beb`. The UI bridge initially timed out on the old idle diagnostic window; Codex stopped that terminal process, verified it exited, launched the new bundle, and verified its native Ready to start state, input permission, and shortcuts. The new content-free console log is `agent-scratch/no-speech-512-calibration.log`. Rejection and phrase retirement were disabled for all calibration takes.

The user explicitly confirmed the first three requested spoken controls all transcribed correctly, and reported every silent tap produced “Thank you.” The nine completed operations below form this calibration partition; none is a held-out acceptance result. Individual handling-noise labels among the six silent takes were not confirmed separately.

| Operation | Confirmed control | Whole/request maximum | Final remainder score | Hold ms |
| --- | --- | ---: | ---: | ---: |
| 1 | Quiet no, immediate release | 0.917809 / 0.917809 | 0.042105 | 1147 |
| 2 | Whispered yes, immediate release | 0.990624 / 0.990624 | 0.023283 | 2798 |
| 3 | Quiet thank you | 0.905976 / 0.905976 | 0.634558 | 945 |
| 4 | Silent tap | 0.036247 / Unknown | 0.004737 | 114 |
| 5 | Silent tap | 0.018439 / Unknown | 0.004853 | 114 |
| 6 | Silent tap | 0.038906 / Unknown | 0.005388 | 116 |
| 7 | Silent tap | 0.042123 / Unknown | 0.004620 | 113 |
| 8 | Silent tap | 0.026389 / Unknown | 0.004116 | 119 |
| 9 | Silent tap | 0.051017 / Unknown | 0.004381 | 126 |

All whole-session analyses completed and were ready at dispatch; request-only Unknown on the short padded recordings does not invalidate the already-complete whole gate. None of the final remainder scores exceeded its full-window maximum. Cold initialization was 24.225 ms on the worker. All nine saved WAVs are preserved locally in `agent-scratch/no-speech-calibration/dji-512-calibration/`, excluded from commits and fixture creation.

Freeze the new acceptance candidate at `Some(0.08)` using only this corrected-scorer calibration partition: maximum observed negative 0.051017, minimum spoken whole/request score 0.905976. The old 480-sample cutoff is not calibration evidence for this value. Activate dictation phrase-filter retirement in the same candidate through the existing shared constant; ordinary use remains gated on fresh held-out speech/silence, native lifecycle checks, and the unchanged full smoke. Do not tune against the held-out results.

One calibration timing outlier needs continued inspection: operation 2 spent 2,593 ms before samples were retrieved and 2,702 ms in the stop handler, with no recorder stop timeout. Its detector was already loaded (`init_us=0`), and inference accumulated 535.587 ms. Existing stop logs cannot separate UI/manager work, capture stop, and scheduling; do not attribute the delay to model loading or claim no latency regression. Four content-free checkpoints have been added around existing UI handling, incremental-stop signaling, ownership lookup, and capture stop. They change no order, locks, or recording behavior and will localize any recurrence during enabled acceptance. No new test or harness was added.

All 155 unchanged Rust tests, the native fast build, and transcription preflight passed after freezing the new candidate cutoff and adding those checkpoints. Existing test modules were untouched. Native held-out acceptance and the full existing smoke are still pending.

### Enabled corrected acceptance candidate, October 23 at 21:01 Pacific

The candidate bundle passed signature verification; executable SHA-256 is `06a7ba30817e959a6bb806484ccf195e4e3eec3263919b8a5eb7b2731033790e`. The unchanged full native smoke was attempted twice with generated speech “Subtitles by the Amara.org community.” Both runs compiled and started recording, then failed before transcription because TextEdit could not become frontmost. This is a native automation/focus verification blocker, not an observed speech-gate failure. The harness was not changed; do not claim phrase/paste/history smoke success. Local evidence is under `agent-scratch/release-transcribe-smoke/2026-10-24T03-55-03-875Z/` and `2026-10-24T03-59-13-601Z/`; cleanup stopped both isolated app instances and closed their own scratch documents. No screenshots were reached.

Codex then launched the packaged candidate directly at 21:01:23 Pacific on DJI MIC MINI at 48 kHz stereo, with input permission and initialized shortcuts. Native UI shows Ready to start. Content-free logs are in `agent-scratch/no-speech-512-acceptance.log`; the stop checkpoints are present in this bundle. Read-only history metadata immediately before the held-out set showed 77 total rows and latest ID 8533.

Fresh held-out controls have been requested in order: three silent taps including gentle handling on the third; separate quiet yes/no/bye/thank-you and whispered yes; timed 3/5-second initial silence followed by yes/no; and three final silent taps. The user was explicitly told blocking is now on. This partition must pass without tuning the frozen cutoff. Cancellation, long incremental and borrowed-session checks, and a quoted subtitle-credit preservation check remain pending as well.

### Corrected scorer acceptance failure, October 23 at 21:03 Pacific

The user reported that approximately five seconds of silence produced “Thank you.” and explicitly confirmed the recording was silent the whole time. The user separately confirmed that quiet yes/no/bye/thank-you and whispered yes all appeared correctly in this batch. The nine captures do not match the entire requested sequence, so do not infer other control labels from their order, scores, or recognized text. Initial-silence-then-word controls remain unconfirmed for this batch.

The last two recordings (operations 8 and 9) held for 4,006 and 3,177 ms, respectively, and each dispatched ASR and pasted a 10-character result. Their complete, ready whole-recording and retained-request maxima were 0.10048628 and 0.13067126, above the frozen 0.08 cutoff. Initialization was already complete (`init_us=0`). Their final remainder scores were only 0.005649239 and 0.0068866014, so the full chronological windows caused the pass-through. This failure is not an analysis backlog, cold-loading fallback, or repetition of the repaired final-window duplication. The user confirmed the reported failure was wholly silent; correspondence of that report to one or both exact takes is not separately established.

Operation 6 was rejected with complete evidence and maximum 0.05177766, with no provider dispatch. Its exact intended control is unconfirmed. The batch establishes an acceptance failure and user-confirmed preservation of all five requested quiet replies; it does not establish an aggregate silent-rejection rate. Eight saved WAVs were copied to ignored `agent-scratch/no-speech-calibration/dji-512-heldout-failed/` before retention could remove them. No recordings were uploaded or added to fixtures or commits.

The configured rule behaved as written: a single 32 ms window above the low cutoff allows transcription. Calibration contained six short silent taps but no labeled multi-second silence or handling-noise negative for this corrected sequence. That calibration was insufficient for the required longer-silence behavior. No new implementation defect is established by these logs. Do not increase the cutoff using this failed held-out batch and call the result independently validated.

The next evidence needed is a representative, separately labeled calibration set covering multi-second silence and handling noise alongside natural quiet/short speech and speech after initial silence. A prospective cutoff must be selected from that set and frozen before fresh held-out checks. If those classes cannot be separated, the approved maximum-score rule must be revised before further implementation; do not guess a duration, energy, or consecutive-frame rule that could discard quiet short replies. Existing saved retained WAVs and the old 480-sample replay tool cannot reproduce the exact raw 512-sample production sequence. The user's prohibition on new tests and replay harnesses remains in force.

All nine current stop-handler measurements were 37–76 ms. The new checkpoints put capture-stop work at 1–10 ms; the earlier 2.7-second outlier did not recur, but its cause is still unknown. These measurements do not establish exact stop-to-paste latency or a no-regression claim.

At 21:07 Pacific, the failed candidate was confirmed idle and quit, then Codex launched the existing signed baseline bundle from `agent-scratch/no-speech-baseline/Uttr.app`. Startup confirmed DJI MIC MINI at 48 kHz stereo. The source cutoff was restored to `None`, reverting rejection and phrase-filter retirement together. This restores prior behavior; it does not fix the original hallucination. The latest rollback log is `agent-scratch/no-speech-long-silence-rollback.log`.

The rollback passed all 155 existing Rust tests, `bun run tauri:build:fast`, and the unchanged transcription preflight. Native UI confirmed the restored baseline was Ready to start. No tests, fixtures, or harnesses changed. The earlier full-smoke focus blocker remains unresolved.

### Bounded calibration retry

The pinned `vad-rs` revision `88b3a01`, `src/vad_result.rs`, classifies probabilities below 0.35 as Silence, above 0.5 as Speech, and the interval between as Unknown. Our observer calls `compute` directly, so it has not used those labels. The dependency boundary is a fixed candidate hypothesis, not proof of speech preservation. [Silero v4's reference code](https://github.com/snakers4/silero-vad/blob/v4.0/utils_vad.py) defaults to a 0.5 speech threshold and recommends application-specific tuning. Do not import its offline segmenter's minimum speech-duration rule.

Before collecting new calibration data, predeclare 0.35 as the only candidate for this retry. Keep production rejection disabled. Reuse the corrected 512-sample calibration's three confirmed spoken controls and six silent taps, since scoring, capture, gain, model, and DJI settings are unchanged. Add wholly silent 3-, 5-, and 15-second recordings plus a 5-second silent recording with gentle microphone handling. Longer recordings must be checked at every actual incremental and final request boundary, as well as whole-session completion. Confirm the intended labels; Unknown evidence is fallback behavior, not a successful silent classification. Keep both failed acceptance batches separate from calibration.

Evaluate this fixed candidate once: all negative calibration maxima must be below 0.35 and every relevant whole/request positive score above it, with the observed separation reported. If that fails, stop this retry and revise the decision rule through plan review rather than adjusting the threshold again. If it passes, activate the unchanged 0.35 candidate with phrase-filter retirement and run fresh independent controls for all required quiet words, whispers, immediate release, silent taps, longer silence, handling, and speech after initial silence. Calibration success alone does not authorize ordinary-use activation. The latest acceptance's five user-confirmed quiet replies are recorded as preservation evidence for the failed 0.08 candidate, not used to select the new cutoff.

Fresh plan refinement found no material issues in this bounded retry. The disabled diagnostic app was packaged with the existing command-only updater-artifact override and passed signature verification. Executable SHA-256: `bbb404bae54f78e85c5f9f9e717f68783ef8532d1141289eef262c767d596080`. Codex launched it at 21:15 Pacific; startup confirmed DJI MIC MINI at 48 kHz stereo and initialized shortcuts, and the native UI showed Ready to start. The baseline was idle and exited before launch. The diagnostic log is `agent-scratch/no-speech-long-calibration.log`; history metadata before the four new requested silent controls was 77 rows, latest ID 8541. These recordings are pending. Blocking is explicitly disabled, so pasted artifacts during calibration do not indicate an enabled rejection failure.

### User stopped recording requests; autonomous investigation

The user completed only the first requested silent take and reported “Thank you,” then explicitly instructed Codex to stop requesting recordings and do substantially more work independently. This supersedes the remaining calibration request and any plan step that depended on another requested human batch. Do not ask for a replacement batch or call missing checks passed. No new tests, fixtures, or harnesses are authorized.

The new take held for 2,186 ms and produced 43,064 raw / 31,040 retained samples, with complete whole/request maximum 0.02621609. Cold initialization took 31.585 ms; the stop handler took 37 ms. All gate logs explicitly show `enabled=false rejected=false`. This take was allowed by the deliberately disabled diagnostic gate, not misclassified above either candidate cutoff. The local WAV was preserved under `agent-scratch/no-speech-calibration/dji-long-calibration/`. It is a confirmed silent negative; the abandoned remaining controls were not recorded.

Independent source review verified that the bundled model Git blob `e6db48d6e2a0797a2ec173c008384f7710189344` matches the official [Silero v4 model](https://github.com/snakers4/silero-vad/blob/v4.0/files/silero_vad.onnx), with local SHA-256 `a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28`. The corrected observer's 512-sample sequential inputs, per-session reset, and final-only padding agree with the reference contract. No new model/version mismatch or short-recording coverage defect explains the complete 0.100/0.131 failures.

The fixed 0.35 candidate separates every existing corrected-scorer confirmed positive from the reported silent-failure maxima. That is retrospective consistency, not independent acceptance, and it does not establish every future voice/noise condition. Do not add minimum speech duration, consecutive-frame requirements, average-score dilution, an energy floor, or a model upgrade without evidence: these would change the short/quiet-speech contract or invalidate the existing measurements.

The deeper audit found a concrete uncovered dispatch path: `transcribe_cloud_with_settings` splits large full-pass audio at upload limits and directly sends each subrequest without dictation context, after only a parent-level check. Speech in one part can therefore allow a silent subrequest. Repair this within the original every-request scope, preserving original retained coordinates even when prior rejected ranges were removed. This path is reached at approximately 13.1 minutes of retained audio for direct routes and 52.4 minutes for proxy; it is not the explanation for the latest short clips.

Two other limits require explicit disposition. Rapid restart can include finish-padding or uncertain resampler output in the 500 ms pre-roll; the current code conservatively invalidates that entire analysis and passes through. Changing a cutoff cannot close that fallback window. The permanent rejection ledger also removes overlap from later requests, which creates a possible clipped-word boundary risk if speech becomes detectable only in a later chunk; no captured failure demonstrates that case. A timed hold alone does not prove incremental coverage because chunking uses retained samples after capture filtering.

Tool discovery found no unchanged local CLI that reproduces the exact current observer: the scratch scorer uses 480-sample windows, vendor `vad-rs` WAV examples hardcode 1600 and append silence, file import bypasses the observer, and the existing native smoke injects audio at stop and invalidates evidence. Saved history WAVs are retained PCM16, not complete original raw observer inputs. These limits prevent claiming an exact replay, but they do not prevent source-level repairs, existing-suite validation, and numeric checks against already observed production scores. The installed local Whisper CLI is a different ASR model and is not a substitute for this verification.

### Resampler restart defect and bounded repair

Further source inspection proves an existing duplicate-input defect in `FrameResampler`: finish pads and processes the wrapper `in_buf` but leaves it full. The next push takes zero new samples on its first loop and processes that already-consumed input again. This is also present in baseline `090f787`; it can repeat old audio across a recording boundary. Clear the consumed wrapper buffer after the finish processing attempt, including errors, and remove accounting that assumes this duplicate input is deliberately replayed.

Preserve Rubato's internal filter state and conservative uncertainty around output affected by input padding. At the DJI 48-to-16 kHz ratio, the existing 512-input configuration uses 513-sample FFT input / 171-sample output units with 85 output samples of delay. Internal unmatched input and convolution overlap survive each process call. Resetting those buffers could lose genuine tail audio; declaring their delayed output fully genuine would be unsafe. This bounded repair removes duplicated input only. Known wrapper-added zeros versus uncertain filtered output remain conservatively conflated in pre-roll metadata, so rapid-restart fallback remains a documented limit rather than a passed check.

The current six recorder tests cover lifecycle, pre-roll draining, quiet-energy rescue, and a separate whole-file resampler. There is no existing dynamic test for `FrameResampler` finish/restart validity. Use unchanged tests, compilation, and an independent source trace; report that native verification gap without adding a harness or requesting recordings.

### Existing corrected-scorer regression evidence

| Evidence | Confirmed cases | Observed maximum-score range | Fixed 0.35 comparison |
| --- | ---: | ---: | --- |
| Quiet no, whispered yes, quiet thank-you calibration | 3 | 0.90597594–0.99062383 | All pass |
| User-confirmed quiet yes/no/bye/thank-you and whisper during failed acceptance | 5 | 0.88422024–0.96543610 | All pass |
| Corrected calibration silent taps | 6 | 0.018438965–0.051016808 | All reject at completed whole-recording gate |
| Latest user-confirmed wholly silent take | 1 | 0.02621609 | Rejects with complete whole/request evidence |
| Two final requests surrounding the reported longer-silence failure | Exact individual labels unresolved | 0.10048628 and 0.13067126 | Both reject; do not infer a two-case rejection rate |

These are direct comparisons with the already logged production evidence, not a new audio replay, fresh held-out result, or population guarantee. Old 480-sample scores are excluded. A 0.35 comparison does not reject Unknown evidence, fix pre-roll uncertainty, or prove large-upload behavior. User-reported spoken output establishes capture/provider preservation for the previous candidate; it is not proof of a newly rebuilt candidate's behavior.

### Autonomous repairs and remaining verification boundary

The upload-limit repair now carries ordered original retained-audio spans alongside compacted PCM. Both single and split cloud dispatches recheck ready evidence; malformed mappings pass through. New rejected spans enter the shared ledger before later overlapping chunks, and proxy usage counts surviving unique samples. All-skipped dispatch returns `NoSpeech`, skipped incremental chunks advance the consumed position without increasing successful-chunk count, and late rejection preserves immediate model-unload cleanup. Public signatures, provider selection, and the disabled cutoff are unchanged. Ten unchanged transcription tests passed. Independent source review found no actionable mapping, overlap, accounting, cancellation, or cleanup regression. Those tests do not dynamically exercise the new mapping code.

Provider-internal quiet-audio retries and cloud-to-local rescue continue to use already admitted PCM. Their retry points do not perform another evidence check after the first provider attempt; the upload repair does not establish that broader every-attempt contract. This remains explicit under the unfinished every-request verification item, rather than being hidden by the completed upload-splitting repair.

The resampler repair clears the wrapper input after its finish processing attempt, including errors, and removes the obsolete duplicate-input accounting. An independent source trace covered partial finish followed by push, repeated finish, exact alignment, no-resampling, and processing failure. Six unchanged recorder tests passed. Rubato internal state and conservative transition uncertainty are preserved. No existing test exercises this precise finish/restart path, so the source-level correction is not a native acceptance result.

| Required behavior | Existing evidence | Remaining gap |
| --- | --- | --- |
| Quiet/short words and whispers | Eight user-confirmed corrected-scorer spoken controls appeared; fixed 0.35 comparison preserves all eight | No enabled 0.35 native acceptance; repairs changed capture/dispatch afterward |
| Silent taps and longer silence | Six confirmed short silent calibration takes and the latest confirmed longer silent take all score below 0.35; earlier enabled 0.08 longer-silence acceptance failed | No independent enabled 0.35 result or reliable aggregate rejection rate |
| Handling noise | One older short clip explicitly confirmed as silence/handling noise; corrected silent-tap individual handling labels unresolved | No separately labeled corrected-scorer handling control |
| Initial silence then speech | Baseline user check included three seconds then yes and was reported working | No confirmed corrected-scorer 3/5-second leading-silence control |
| Rapid restart and cancellation | Source isolates operations and preserves uncertain-evidence fallback; consumed-input replay repaired | Native cancellation/restart isolation and the conditional pre-roll Unknown window remain unverified |
| Incremental, large-upload, and borrowed dictation | Original-coordinate mappings and borrowed full-segment repair source-reviewed; existing tests compile/pass | No native proof for rejection boundaries, word overlap, or restored meeting ownership |
| Paste/history/overlay cleanup and retired phrases | One complete rejection observed in the failed 0.08 batch; spoken thank-you and bye appeared | Full existing smoke stopped at TextEdit focus before transcription; quoted subtitle-credit preservation and full cleanup contract unverified |

No further recordings are requested. The unchanged native smoke injects audio at stop and invalidates observer evidence, so even resolving its focus failure would not prove the missing acoustic acceptance. Existing saved WAVs cannot reproduce original raw observer samples. Keep ordinary-use rejection and phrase retirement disabled; no new tests or replay harnesses were added to bridge these gaps.

### Current latency evidence

Re-reading the corrected-scorer production logs gives these small-sample measurements. Median/p95 use nearest-rank p95; for these counts p95 is the maximum. Start/stop are handler measurements, and provider-stage timing excludes final paste and some scheduling.

| Session | Takes | Start ms median/p95 | Stop ms median/p95 | Provider stage ms median/p95 |
| --- | ---: | ---: | ---: | ---: |
| Saved baseline | 10 | 35.5 / 47 | 37.5 / 103 | 308 / 333 |
| Corrected 512 calibration, disabled | 9 | 40 / 49 | 37 / 2702 | 294 / 793 |
| Corrected 0.08 failed acceptance | 9 | 35 / 82 | 44 / 76 | 295.5 / 721 (8 provider calls) |
| Latest disabled silent take | 1 | 44 / 44 | 37 / 37 | 494 / 494 |

The three corrected sessions initialized the detector in 24.225, 30.550, and 31.585 ms on its worker; subsequent operations reported zero initialization time. Capture does not await that worker, and request checks use ready evidence without waiting. These are source properties and observed timings, not a causal overhead estimate. The unexplained 2702 ms stop outlier remains a limitation; later checkpoints measured capture-stop work at 1–10 ms and the outlier did not recur. Exact stop-to-paste median/p95, cold-tap fallback frequency, and population rejection rates remain unknown. These measurements predate the two latest repairs.

After both autonomous repairs, all 155 unchanged Rust tests passed, `bun run tauri:build:fast` passed (including the frontend build), and `bun run test:e2e:release-transcribe -- --preflight-only` passed. The preflight result is under `agent-scratch/release-transcribe-smoke/2026-10-24T04-40-51-775Z/`. Formatting and diff checks passed. No test, fixture, or smoke-script changes were made. The fast build updates `src-tauri/target/debug/uttr`; it does not update the running app bundle. No app was restarted and no microphone recording was initiated during this autonomous pass. The existing disabled diagnostic bundle remains the last launched version.

Completion is blocked by missing acoustic/native acceptance, not by a failing build or unit suite. The unchanged automation cannot provide that evidence, and neither speculative activation nor more requested recordings is appropriate. The plan stays active and unarchived, with ordinary rejection disabled. The two focused repairs received independent source reviews; this is not a completed full-branch Deliver final review, which remains pending the unresolved verification requirements.

### Resumed completion using existing recordings

The user explicitly rejected stopping and instructed Codex to keep working until fixed using the recordings already available, with no further recording requests. The previous blanket ban on disposable replay was an overly broad interpretation of the user's instruction not to write new tests. Keep the automated suite and committed fixtures unchanged; local disposable analysis that invokes production code is now the verification route. This supersedes the earlier stop decision and fresh-human-acceptance prerequisite. It does not authorize fabricated native coverage, new microphone capture, private audio upload, or threshold tuning to each failure.

Use a scratch-only executable that includes the actual `speech_observer.rs` source, decodes the saved mono 16 kHz PCM16 WAVs, and exercises its public session/evidence API plus parent-visible observe/retain/finish methods. Do not copy the model algorithm. Pace feeds to avoid artificially overflowing the production bounded queue. Preserve labels and report original length, exact-zero suffix removal if used, whole/request maxima, readiness, and timing. Compare both unchanged WAVs and clearly described transformations; saved retained PCM is not the original raw capture timeline. Reuse one observer across speech/silence sessions to exercise reset, and prepend 3/5 seconds of saved silence to confirmed quiet words to exercise leading-silence behavior. These are derived replay cases, not new human recordings or independent held-out data.

Close the remaining actual-attempt boundary: retain the mapped request context into OpenAI quiet rescue, Groq fallback, proxy upload after any prefix-only trim, and local inference after model loading. Recheck ready evidence without waiting. Distinguish an entirely skipped logical request from a later skipped retry after a provider returned empty; a late skip must not falsely imply zero prior calls or miscount successful incremental requests. Preserve provider errors and normal fallback on Unknown. Keep changes within existing transcription ownership.

The activation decision will use the fixed 0.35 contract, the existing observed raw-score separation, production-code replay of saved controls, source review of capture boundaries, and the existing checks. Native hardware cases not recreated by replay remain reported limitations rather than a reason to demand another user batch. Package and launch the actual updated bundle from Codex once verification passes.

### Production replay rejects 0.35; replacement calibration

The scratch executable includes the actual production `speech_observer.rs` (SHA-256 `27fcd733929317b444354176f5bd0d564ba5d2eacf2bce3d41398eea6b03761d`). Its 74 cases cover eight distinct confirmed speech recordings, eight distinct confirmed silent recordings, two ambiguously labeled longer-failure recordings, logged retained-length variants, leading saved-noise/zero prefixes, a derived 15-second silent stream, repeated sessions, cancellation/replacement, and expected sub-512 Unknown inputs. Source/commands/results and file hashes are in `agent-scratch/no-speech-production-replay/`; nothing was uploaded or added to the automated suite.

All eight standalone spoken controls pass 0.35, but one confirmed quiet spoken clip falls from 0.446924686 alone to 0.339643180 after three seconds of repeated saved silence. Its exact word is not separately established within the user-confirmed five-word group. The same clip after five seconds scores 0.368288159. This is a genuine failure of the proposed rule on a derived retained-PCM speech case, not a new human capture failure. Reject the 0.35 activation candidate rather than ignoring the case or pretending it passed.

Across this first replay partition, the highest confirmed silent score is 0.148947805 and the lowest spoken score is 0.339643180. The gap midpoint is 0.24429549. Choose and freeze 0.20 below that midpoint to favor preserving quiet speech: margin 0.051052195 above the highest silent score, 0.139643180 below the lowest spoken score. Existing corrected-scorer original-raw speech controls are all above 0.884, and the failed longer-silence associated raw maxima are 0.100/0.131. This replaces the previous fixed-0.35 contract, not a lexical exception or a claim of independent acceptance. The partition is not the entire saved labeled corpus: seven older confirmed spoken controls and another negative in `dji/` must also be replayed with the current production scorer. Their old 480-sample scores cannot calibrate the new scorer, but their WAVs are useful current replay inputs.

Before activation, use a frozen set of additional frame alignments and initial-silence combinations across all eight speech and eight silence controls, keeping 0.20 unchanged. Preserve all expected Unknown paths. Any new mismatch requires investigation of the actual input and score sequence; do not automatically move the threshold again. Retained PCM quantization/filtering and synthetic prefixing remain explicit limits. Model initialization and diagnostic completion waits are not native latency measurements.

### Rapid restart: available output versus missing audio

After the consumed-input replay fix, the remaining post-finish uncertainty window does not represent missing PCM. Rubato supplies finite filtered output, sometimes mixing the preceding genuine tail or new onset with native input zeros used to finish its block. The observer should analyze those available samples. Only literal zeros appended afterward by the wrapper's `pending.resize` are excluded from source coverage. Actual resampling failure remains Unknown.

Revise the metadata contract and pre-roll handling atomically: `Some(valid)` describes the prefix produced by the resampler; analyze all such output while preserving filter state. Remove the obsolete position-based native-padding uncertainty window. Pre-roll appends only that prefix, excluding wrapper-added zeros from both the next recording's retained PCM and observer input. Do not truncate under the old `real_output_end` rule, because that could remove genuine filter tail. Current recording PCM and framing remain unchanged by this metadata repair; only artificial zeros are omitted from future pre-roll. No waiting, minimum duration, or filter reset is added.

Verify with scratch analysis of the actual resampler and observer using saved controls converted to derived 48 kHz input, including partial/aligned finish, immediate restart, repeated finish, speech/silence transitions, and onset spanning a boundary. Compare PCM before/after the metadata change and report native-rate conversion as synthetic replay, not physical DJI coverage. This removes a demonstrated artificial-uncertainty path; true failure, incomplete analysis, and background speech remain conservative pass-through cases.

### Older controls reject 0.20; investigate the acoustic representation

The additional eight old DJI WAVs were mapped to original operations and replayed with the unchanged current observer. Seven are confirmed speech and one is a silent tap. The original whispered yes scores 0.093372196 and falls to 0.056460291 after five seconds of saved noise. Of 40 speech variants, nine fail 0.20. All ten silent variants reject. There were five expected Unknown cases and no unexpected Unknowns or timeouts. Exact manifests and results are in `agent-scratch/no-speech-production-replay/older-*`. These are current 512-window scores; the invalid older 480-window scalar scores were not reused.

This invalidates 0.20 and supersedes the previous activation candidate. A single cutoff on the current score does not separate all saved controls. Inspect the supported 512/1024/1536 model windows, complete score sequences, padding influence, and quiet-audio representation before selecting a replacement. The official v4 reference accepts those three window sizes and resets recurrent state once per recording. Compare them in disposable local analysis using the actual bundled model and library; no permanent tests, new microphone recordings, or private uploads. Preserve the complete saved corpus and labels, report derived transformations explicitly, and avoid per-word exceptions or a silent duration rule. Any adopted production algorithm must then pass replay through its actual source.

### Actual provider invocation gates completed

Mapped context now reaches direct Groq, both OpenAI attempts and its Groq rescue, proxy dispatch after access checks and trimming, and local inference after model loading, including direct incremental local calls. Ready evidence is rechecked without waiting. Private helpers preserve `NoSpeech` through retries; logical successful chunk counts include Text outcomes only. Shared attempted/completed invocation counters prevent late suppression from claiming zero earlier calls. Proxy usage is recalculated from surviving unique samples after filtering and prefix-only trimming, with original audio/context retained for local fallback.

All ten unchanged transcription tests, rustfmt, and diff checks passed. Independent source review found no actionable issue in the actual-attempt gates, coordinate mapping, usage, cleanup, None cutoff behavior, or non-dictation paths. Late evidence and provider retry counters were traced, not dynamically exercised by those tests. No automated tests changed. The acoustic gate remains disabled pending a rule that preserves the entire saved corpus.

### Supported-window comparison and next diagnostic

The fixed v4 comparison ran 95 inputs at each of 512, 1024, and 1536 samples (285 cases, 22,458 model windows), with no inference errors. All 95 comparable 512 scores exactly reproduced the earlier production replay. All three sizes overlap when the complete saved WAVs are included. Known ASR-padding removal reduces negative maxima, but even the best retained-only 1024 gap is only 0.023102 (speech minimum 0.057092, silence maximum 0.033990). This does not establish a safe raw-capture rule. Full score sequences are in `agent-scratch/no-speech-window-analysis/`; no cutoff or production window was changed.

Evaluate the official tagged Silero v6.2.3 streaming model next, solely as a local diagnostic comparator. The [v6.2 release](https://github.com/snakers4/silero-vad/releases/tag/v6.2) describes better handling of muted voices and edge cases; that motivates a comparison, not an assumption it fixes these recordings. Use the [versioned ONNX wrapper contract](https://github.com/snakers4/silero-vad/blob/v6.2.3/src/silero_vad/utils_vad.py): 512 new 16 kHz samples, 64 preceding context samples, and state shaped (2,1,128), reset per recording. The v4 vad_rs wrapper is incompatible. Keep model provenance/hash/license, every saved control, fixed prefix/alignment variants, inference timing, and failures. Adopt no production model until its own score evidence and integration review justify the change.

### Rapid-restart metadata repair verified

The atomic repair observes all actual filtered output and retains only that produced prefix in pre-roll. It removes obsolete native-padding uncertainty bookkeeping without resetting Rubato or changing PCM. A discovered failure path is also closed: a final resampler error with no pending output now emits empty None metadata, so the observer cannot certify earlier samples while missing failed input. Both recorder callbacks consume that notification and return before capture VAD sees an empty frame. Malformed prefix lengths remain Unknown.

Six unchanged recorder tests passed. Scratch replay compared 125,760 emitted samples bit-for-bit against the prior implementation at derived 48-to-16 kHz and direct16 kHz; every sample matched. Fourteen sessions, including immediate restart and speech crossing a boundary, obtained complete whole/request evidence, and repeated finish emitted no new audio. Two induced actual Rubato validation errors produced Unknown without added PCM. Pre-roll prefix, unknown, overflow, and zero-capacity checks passed. Source/metadata/results are in `agent-scratch/no-speech-resampler-replay/`. The runner includes actual resampler/observer source and verbatim extracted recorder methods; it is not physical microphone or acoustic-threshold acceptance.

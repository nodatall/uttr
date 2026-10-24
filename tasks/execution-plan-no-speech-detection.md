# Prevent transcriptions from silent microphone recordings

Goal: Reject confidently speech-free dictation without losing quiet words, short replies, or speech after initial silence.

Implementation notes: [implementation-notes-no-speech-detection.md](implementation-notes-no-speech-detection.md)

Finish and enable the fix using the saved DJI recordings and local verification. Request no new recordings. Treat saved-audio replay as regression evidence, and state the microphone details it cannot reproduce.

## Behavior

- Start loading the detector when Transcribe is pressed, alongside microphone capture, and reuse the loaded model. Capture starts immediately.
- Keep listening through initial silence until the user stops. Preserve the existing audio capture and the beginning of words.
- Reject audio as speech-free only when the detector has examined it completely and confidently found no speech. Uncertain results, missing audio, loading delays, and errors proceed through transcription. Replace the old phrase filter when the new detector is enabled; add no minimum recording time.
- Apply this to microphone dictation across every provider, including incremental requests and quick dictation while a meeting owns the microphone. Keep meeting transcription, file imports, and Ask Selection behavior outside this change.
- A wholly rejected recording returns the existing overlay to idle without paste or history. Rejection before the first dispatch makes no transcription request; evidence arriving later stops the remaining attempts. Add no new UI or setting.
- Add no wait for model loading or fixed listening delay. Use evidence ready at each request boundary; incomplete analysis proceeds normally. Measure actual latency rather than promising zero overhead.
- Add or change no automated tests or committed test fixtures. Use disposable local analysis of the saved recordings through production code, existing tests, code review, and available native automation. Keep private audio local and report verification limits.

## Steps

Complete the implementation and autonomous checks using the evidence already collected. Keep prospective microphone verification gaps explicit.

### 1. Establish speech and silence controls

- [x] Consolidate the already collected DJI recordings and labels for silent taps, longer silence, handling noise, quiet replies, whispers, and speech after initial silence. Distinguish confirmed outcomes, failed acceptance, and missing coverage. Request no new recordings. Other microphones remain unverified.
- [x] Check the recordings with existing audio tools and exercise the production capture path manually. Keep private recordings local and out of commits; use existing local diagnostics to inspect retained audio without uploading private recordings.

### 2. Observe speech without changing capture

- [x] Add an independent detector observing resampler-produced capture audio, including pre-roll, before capture filtering, gain, or added output-frame/ASR padding. Map its evidence to retained audio, including the last available samples in a partial frame.
- [x] Correct the observer's final audio window so it never repeats already-examined samples. Use the model's supported frame size; calibrate it in step 3 before enabling rejection.
- [x] Clear resampler input after it has been consumed at stop, so a later recording cannot replay it. Preserve the resampler's filter state and conservative handling of uncertain audio; do not claim this removes every rapid-restart fallback.
- [x] Prevent known output-frame padding from invalidating the next recording. Analyze all available resampler output, preserve its filter state and genuine tail, and keep only explicitly appended zeros out of pre-roll. Actual processing failure still passes through.
- [ ] Verify the on-press loader and per-recording state with saved-audio replay and source tracing, including session reset, cancellation, rapid restarts, and borrowed-microphone ownership. Repair demonstrated defects while preserving uncertainty pass-through.

### 3. Establish a conservative rejection rule

- [x] Replay saved speech and silence through the production observer. Reject both the 0.35 and 0.20 candidates: older confirmed whispered speech overlaps the silence scores.
- [ ] Resolve that overlap by checking the model's supported input windows and score sequences against every recoverable confirmed control. Select a rule only after it preserves spoken controls and rejects known silence across fixed audio alignments and leading-silence variants. Keep uncertainty pass-through and add no word lists, minimum speech duration, or volume floor. Report these as regression checks, not independent human acceptance.

### 4. Apply the rule to every dictation request

- [ ] Apply the rule before every microphone-dictation request, including requests made during recording. Verify that skipping silence preserves later words and cannot resend skipped audio through a fallback request.
- [x] Carry ready evidence into provider retries and local fallback. A late silence decision stops further requests without hiding an earlier completed request.
- [x] Close the uncovered upload-limit splitting path: each actual cloud request must retain its original audio coordinates and receive its own speech check. Preserve cloud-to-local fallback and non-dictation behavior.
- [ ] Retire phrase-based suppression for microphone dictation in the same activation as the new detector. Verify that genuine previously blocked phrases survive, including when detector evidence is uncertain. Preserve the separate punctuation-only rule and existing behavior for other transcription sources.
- [ ] Complete rejected sessions through existing cleanup paths. Verify no paste or history for wholly rejected sessions, no provider calls when rejected before first dispatch, stopped remaining attempts after late rejection, and restored microphone ownership after borrowed dictation.

### 5. Verify the rebuilt native app before activation

- [ ] Run the existing relevant tests, full Rust suite, native build, and transcription preflight. Verify saved-audio rejection and speech preservation through production code; use available native automation for cleanup and paste behavior without recording new microphone audio.
- [x] Review existing native evidence for silent taps, quiet replies, leading silence, cancellation, borrowed dictation, and overlay recovery. Request no recordings and keep uncovered flows explicitly unverified.
- [x] Compare existing cold and warm measurements with the baseline, separating ready-detector rejection from incomplete-analysis fallback. Report sample counts, latency limits, and unknown rejection rates rather than inferring them.
- [ ] Enable the verified rule and phrase-filter retirement together, package the updated app, and run it from Codex. Confirm the running binary is current and report saved-audio results separately from native verification limits.

Deliver implementation instruction:
When asked to implement this doc, load the `$deliver` skill, use this file as the approved execution plan, scan every checkbox, and continue through final review, archive movement, commit, and finalization before the final handoff.

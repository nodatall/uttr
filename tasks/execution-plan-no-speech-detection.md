# Prevent transcriptions from silent microphone recordings

Goal: Reject confidently speech-free dictation without losing quiet words, short replies, or speech after initial silence.

Implementation notes: [implementation-notes-no-speech-detection.md](implementation-notes-no-speech-detection.md)

Rejection is disabled after failed acceptance. The user has stopped further recording requests. Continue with the existing recordings, logs, source review, and existing verification tools; report remaining native gaps without asking for more takes.

## Behavior

- Start loading the detector when Transcribe is pressed, alongside microphone capture, and reuse the loaded model. Capture starts immediately.
- Keep listening through initial silence until the user stops. Preserve the existing audio capture and the beginning of words.
- Reject audio as speech-free only when the detector has examined it completely and confidently found no speech. Uncertain results, missing audio, loading delays, and errors proceed through transcription. Replace the old phrase filter when the new detector is enabled; add no minimum recording time.
- Apply this to microphone dictation across every provider, including incremental requests and quick dictation while a meeting owns the microphone. Keep meeting transcription, file imports, and Ask Selection behavior outside this change.
- A rejected recording returns the existing overlay to idle without a transcription request, paste, or history entry. Add no new UI or setting.
- Add no wait for model loading or fixed listening delay. Use evidence ready at each request boundary; incomplete analysis proceeds normally. Measure actual latency rather than promising zero overhead.
- Add or change no automated tests, test fixtures, or test harnesses. Validate with existing tests and tooling, code review, and direct native checks; report any gaps.

## Steps

Complete the implementation and autonomous checks using the evidence already collected. Keep prospective microphone verification gaps explicit.

### 1. Establish speech and silence controls

- [x] Consolidate the already collected DJI recordings and labels for silent taps, longer silence, handling noise, quiet replies, whispers, and speech after initial silence. Distinguish confirmed outcomes, failed acceptance, and missing coverage. Request no new recordings. Other microphones remain unverified.
- [x] Check the recordings with existing audio tools and exercise the production capture path manually. Keep private recordings local and out of commits; use existing local diagnostics to inspect retained audio without uploading private recordings.

### 2. Observe speech without changing capture

- [x] Add an independent detector observing original audio, including pre-roll, before filtering, gain, or padding. Map its evidence to the audio retained for transcription, including the last real samples in a partial frame.
- [x] Correct the observer's final audio window so it never repeats already-examined samples. Use the model's supported frame size; calibrate it in step 3 before enabling rejection.
- [x] Clear resampler input after it has been consumed at stop, so a later recording cannot replay it. Preserve the resampler's filter state and conservative handling of uncertain audio; do not claim this removes every rapid-restart fallback.
- [ ] Implement the on-press loader and per-recording state. Verify immediate capture with delayed loading, plus isolation across cancellation, rapid restarts, and borrowed-microphone sessions.

### 3. Establish a conservative rejection rule

- [x] Use the highest raw speech score across the relevant audio. Evaluate the previously fixed 0.35 candidate against existing production scores and the model/dependency contracts. Treat this as retrospective regression evidence, not fresh acceptance. Preserve the expired-WAV replay gap and uncertainty pass-through. Do not change the threshold again to fit individual failures or enable ordinary use without adequate verification.

### 4. Apply the rule to every dictation request

- [ ] Apply the rule before every microphone-dictation request, including requests made during recording. Verify that skipping silence preserves later words and cannot resend skipped audio through a fallback request.
- [x] Close the uncovered upload-limit splitting path: each actual cloud request must retain its original audio coordinates and receive its own speech check. Preserve cloud-to-local fallback and non-dictation behavior.
- [ ] Retire phrase-based suppression for microphone dictation in the same activation as the new detector. Verify that genuine previously blocked phrases survive, including when detector evidence is uncertain. Preserve the separate punctuation-only rule and existing behavior for other transcription sources.
- [ ] Complete rejected sessions through existing cleanup paths. Verify zero provider calls, paste actions, and history writes for wholly rejected sessions, plus restored microphone ownership after borrowed dictation.

### 5. Verify the rebuilt native app before activation

- [ ] Run existing relevant tests, required Rust tests, the native build, and transcription preflight. Use direct native checks for rejection and subsecond capture; leave the smoke harness unchanged.
- [x] Review existing native evidence for silent taps, quiet replies, leading silence, cancellation, borrowed dictation, and overlay recovery. Use available existing automation for additional checks. Request no recordings, keep uncovered flows explicitly unverified, and preserve them as activation blockers.
- [x] Compare existing cold and warm measurements with the baseline, separating ready-detector rejection from incomplete-analysis fallback. Report sample counts, latency limits, and unknown rejection rates rather than inferring them. Keep ordinary-use activation disabled while required speech-preservation and native checks remain unverified.

Deliver implementation instruction:
When asked to implement this doc, load the `$deliver` skill, use this file as the approved execution plan, scan every checkbox, and continue through final review, archive movement, commit, and finalization before the final handoff.

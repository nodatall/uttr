# Prevent transcriptions from silent microphone recordings

Goal: Reject confidently speech-free dictation without losing quiet words, short replies, or speech after initial silence.

Implementation notes: [implementation-notes-no-speech-detection.md](implementation-notes-no-speech-detection.md)

## Behavior

- Start loading the detector when Transcribe is pressed, alongside microphone capture, and reuse the loaded model. Capture starts immediately.
- Keep listening through initial silence until the user stops. Preserve the existing audio capture and the beginning of words.
- Reject audio as speech-free only when the detector has examined it completely and confidently found no speech. Uncertain results, missing audio, loading delays, and errors proceed through transcription. Replace the old phrase filter when the new detector is enabled; add no minimum recording time.
- Apply this to microphone dictation across every provider, including incremental requests and quick dictation while a meeting owns the microphone. Keep meeting transcription, file imports, and Ask Selection behavior outside this change.
- A rejected recording returns the existing overlay to idle without a transcription request, paste, or history entry. Add no new UI or setting.
- Add no wait for model loading or fixed listening delay. Use evidence ready at each request boundary; incomplete analysis proceeds normally. Measure actual latency rather than promising zero overhead.
- Add or change no automated tests, test fixtures, or test harnesses. Validate with existing tests and tooling, code review, and direct native checks; report any gaps.

## Steps

Build the observer and dispatch integration while human recordings are pending; calibration and activation still require the recordings and checks below.

### 1. Establish speech and silence controls

- [ ] Obtain consented, labeled recordings: silent taps, handling noise, natural quiet “yes,” “no,” “bye,” and “thank you,” whispers, immediate release after a word, and quiet speech after 3 and 5 seconds of silence. Cover the built-in microphone and one external microphone; separate calibration recordings from held-out checks. Stop activation if suitable human recordings are unavailable.
- [ ] Check the recordings with existing audio tools and exercise the production capture path manually. Keep private recordings local and out of commits; use existing local diagnostics to inspect retained audio without uploading private recordings.

### 2. Observe speech without changing capture

- [ ] Add an independent detector observing original audio, including pre-roll, before filtering, gain, or padding. Map its evidence to the audio retained for transcription, including the last real samples in a partial frame.
- [ ] Implement the on-press loader and per-recording state. Verify immediate capture with delayed loading, plus isolation across cancellation, rapid restarts, and borrowed-microphone sessions.

### 3. Establish a conservative rejection rule

- [ ] Use the highest raw speech score across the relevant audio. Calibrate a low rejection cutoff, then freeze it before the held-out run. With complete, ready evidence, the saved “Bye.” incident and held-out silent taps must be rejected. Every labeled word must survive capture and reach the provider input. Stop before activation or capture redesign if either requirement fails.

### 4. Apply the rule to every dictation request

- [ ] Apply the rule before every microphone-dictation request, including requests made during recording. Verify that skipping silence preserves later words and cannot resend skipped audio through a fallback request.
- [ ] Retire phrase-based suppression for microphone dictation in the same activation as the new detector. Verify that genuine previously blocked phrases survive, including when detector evidence is uncertain. Preserve the separate punctuation-only rule and existing behavior for other transcription sources.
- [ ] Complete rejected sessions through existing cleanup paths. Verify zero provider calls, paste actions, and history writes for wholly rejected sessions, plus restored microphone ownership after borrowed dictation.

### 5. Verify the rebuilt native app before activation

- [ ] Run existing relevant tests, required Rust tests, the native build, and transcription preflight. Use direct native checks for rejection and subsecond capture; leave the smoke harness unchanged.
- [ ] Verify silent taps, quiet replies, leading silence, cancellation, and borrowed dictation in the rebuilt acceptance candidate. Save visual evidence of overlay recovery. Stop activation for ordinary use if permissions or the running-app setup prevent verification.
- [ ] Compare cold and warm recordings with the baseline: measure startup, stop-to-result latency, and actual rejection rates for 119 ms taps and longer recordings. Check incomplete-analysis fallback separately from ready-detector rejection. Confirm the no-wait contract above and report remaining limitations. Enable ordinary use only after these checks and speech preservation pass.

Deliver implementation instruction:
When asked to implement this doc, load the `$deliver` skill, use this file as the approved execution plan, scan every checkbox, and continue through final review, archive movement, commit, and finalization before the final handoff.

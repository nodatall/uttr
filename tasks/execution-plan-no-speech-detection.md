# Prevent transcriptions from silent microphone recordings

Goal: Reject confidently speech-free dictation while preserving quiet words, short replies, and speech after initial silence.

Implementation notes: [implementation-notes-no-speech-detection.md](implementation-notes-no-speech-detection.md)

Use the existing DJI recordings and autonomous local verification. Request no new recordings. Add or change no automated tests or committed fixtures. Keep private audio local, preserve unrelated work, and run the finished app from Codex.

## Behavior

- Load the detector when Transcribe is pressed, alongside immediate capture, and reuse it. Listen until release; add no minimum recording time or extra capture delay.
- Observe original capture audio without changing retention, gain, or word onsets. Combine eight aligned model scores at the same moment, then keep the highest combined score. Initial or trailing silence cannot dilute earlier speech.
- At release, compute the model's final context using synthetic zeros. These zeros never enter captured audio or count as examined real samples. A completed score below 0.16 rejects the whole session; incomplete, invalid, or failed analysis passes through.
- Use the completed session decision at every dictation request and output boundary. Requests made before completion proceed with their full audio. A rejected session finishes idle with no paste or history; stop remaining attempts and report any earlier requests accurately.
- At the final output boundary, allow already-loaded, healthy analysis to finish within one 100 ms deadline measured from release submission. Wake immediately on completion, recheck cancellation, and pass through on timeout. Never wait for model loading or hold recorder locks.
- Retire word-based suppression for microphone dictation when enabling the detector. Preserve punctuation-only handling and non-dictation behavior. Include borrowed-microphone dictation; leave meetings, imports, and Ask Selection outside the policy.
- Acceptance requires every confirmed saved speech/noise control, both possible reported-incident files, and corrected native replays to pass. Keep four known false admissions of one artificially repeated 60-second noise clip visible as a conservative limit; do not raise the cutoff to remove them at the expense of quiet speech. This fixes the reproduced incidents without claiming universal noise rejection.

## Steps

### 1. Establish the recorded evidence

- [x] Preserve and label the recoverable DJI speech, silent taps, handling noise, longer silence, and leading-silence recordings. Keep uncertain incident identities explicit and require both possible incident files to reject.
- [x] Correct the local playback helper and verify saved PCM reaches the native observer intact. Keep virtual replay distinct from fresh physical-microphone acceptance.

### 2. Observe complete audio safely

- [x] Add the bounded observer, asynchronous on-press loading, session reset/cancellation, raw-audio coverage, and borrowed-microphone ownership.
- [x] Repair final-frame duplication and resampler restart metadata. Preserve actual resampler output and report genuine errors as uncertain.

### 3. Implement the verified score

- [x] Replace independent peak averaging with the maximum simultaneous mean of eight 512-sample phases. Include the final partial frame and eight additional model-only zero frames; keep real coverage separate. Reuse one loaded model with independent phase states.
- [x] Match production inference and aggregation against the saved traces, including quiet replies, exact leading-silence variants, both incident files, native inputs, and the disclosed long-loop limitation. Confirm state reset, bounded memory, and unchanged ASR audio.

### 4. Complete rejection and preserve speech

- [x] Preserve full admitted audio and existing overlap. Check actual provider invocations, retries, upload splits, and local fallback with accurate attempt counts.
- [x] Use finalized whole-session evidence consistently across request and output gates. Preserve earlier speech and pass unresolved partial requests without truncation.
- [x] Add the bounded asynchronous completion check before postprocessing/history/paste, including cancellation after the wait. Keep cleanup and borrowed ownership intact.
- [x] Enable the verified score and dictation phrase-filter retirement together. Confirm genuine previously blocked phrases survive and other transcription sources retain their behavior.

### 5. Verify and run the finished app

- [ ] Run the unchanged relevant tests, full Rust suite, native build, and transcription preflight. Run available native smoke and saved-audio flows; distinguish actual UI/paste verification from logs and offline replay.
- [ ] Measure cold/warm readiness, stop-to-decision timing, timeouts, and remaining ASR requests. Report native scheduling separately from offline inference costs and make no zero-latency claim.
- [ ] Remove all diagnostic instrumentation, package and verify the current app, restore the original DJI/provider settings, and launch it from Codex. Keep other microphones and uncovered native flows explicitly unverified.

Deliver implementation instruction:
When asked to implement this doc, load the `$deliver` skill, use this file as the approved execution plan, scan every checkbox, and continue through final review, archive movement, commit, and finalization before the final handoff.

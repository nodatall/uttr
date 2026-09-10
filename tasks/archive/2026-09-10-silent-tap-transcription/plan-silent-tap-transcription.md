# Fix the silent-tap “thank you” result

Date: 2026-09-10
Status: Source diagnosis for the Deliver execution plan.

## Goal

Prevent the reported silent tap from pasting or saving “Thank you.” while preserving a genuinely spoken, quiet “thank you”. Keep this first fix within the existing transcription-result filter.

## Confirmed cause

At 11:00:12 PDT, Uttr recorded a 107 ms press. The retained and padded audio had RMS 0.000768 and peak 0.029622 before amplification. The existing silence filter requires RMS at most 0.0035 and peak at most 0.02, so a brief spike defeated it. Uttr amplified the clip 4×, Groq Whisper returned “Thank you.”, and the result was saved and pasted. Post-processing was off.

An offline replay of the saved recording through the current Rust filter confirms `suppressed=false`. Only one 30 ms frame exceeds the peak cutoff. The source of that spike is unverified.

Local-only evidence is retained under `agent-scratch/silence-diagnosis-2026-09-10/` and `agent-scratch/silent-tap-deliver/`. Original audio, app logs, history, and generated test artifacts are not committed.

## Plan

1. **Add the missing regression test.** Use a synthetic quiet clip with an isolated spike matching the incident and a mocked “Thank you.” result. Keep the actual saved recording as a local replay fixture in gitignored `agent-scratch`.
2. **Adjust the existing result filter.** Make the smallest change to `should_suppress_silence_hallucination` that catches this low-energy case. Evaluate a slightly more permissive peak cutoff for the existing known-artifact phrases while retaining the low-RMS requirement. Choose it against both the incident and quiet-speech controls. Avoid changing the shared `is_effectively_silent` helper, which also governs gain and retries, unless separate evidence requires it.
3. **Verify real speech and the actual paste flow.** The incident and synthetic case must be suppressed; normal and quiet spoken “thank you”, “yes”, and “no” must still work. Verify silent taps produce no text or transcript history entry and the overlay returns to idle. Measure release-to-paste time before and after.

The initial implementation is expected in [transcription.rs](/Volumes/Code/uttr/src-tauri/src/managers/transcription.rs:243) and its existing tests. Use realistic speech recordings for positive controls; amplitude-only synthetic tests cannot establish that quiet speech remains usable. If the small adjustment cannot separate this incident from legitimate speech, report that evidence before expanding the design.

This scope adds no new speech-detection stage, buffering changes, provider metadata, or network requests. The existing transcription request still occurs; the filter rejects the unwanted returned text. Added latency should be negligible, subject to measurement. It addresses this known artifact rather than guaranteeing rejection of every possible hallucination.

## Required validation when implemented

Run the targeted regression and existing filter tests, then `cd src-tauri && cargo test`, `bun run tauri:build:fast`, and `bun run test:e2e:release-transcribe -- --preflight-only`. Run the full native smoke when permissions allow. Capture evidence of the actual silent-tap and quiet-speech flows, including which executable was tested. Report any verification blocker explicitly.

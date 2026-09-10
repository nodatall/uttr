# Fix the silent-tap “thank you” result

Goal: Suppress the reported near-silent “Thank you.” result while preserving quiet spoken phrases and normal dictation speed.

Fast mode note: Initial plan-review pause skipped by --fast; continue into implementation after refinement unless a fast-mode stop condition applies.

Deliver implementation instruction:
When asked to implement this doc, load the `$deliver` skill, use this file as the approved execution plan, scan every checkbox, and continue through final review, archive movement, commit, and finalization before the final handoff.

## Context

- The incident was a 107 ms press with pre-gain RMS 0.000768 and peak 0.029622. The current phrase filter misses it because peak exceeds 0.02; an offline replay confirmed the miss.
- Keep the fix in the existing transcription-result filter. Preserve capture, pre-roll, gain, retries, provider requests, and UI behavior. The request still occurs; an unwanted result is suppressed afterward.
- Add a narrow exception for very low overall energy with a modest spike, retaining the current silence test. Avoid globally relaxing the existing silence/gain threshold or blocking “thank you” regardless of audio.
- Use the saved incident locally and synthetic regression data in the existing Rust test group. Protect quiet speech using actual audio controls, including “thank you”, “yes”, and “no”.
- Before changing code, preserve the baseline executable in `agent-scratch/silent-tap-deliver/uttr-baseline`; compare baseline and candidate with the same native inputs. Quiet spoken “thank you” is the decisive filter control.
- Source diagnosis: [plan-silent-tap-transcription.md](plan-silent-tap-transcription.md).

## Steps

### 1. Reproduce and fix the filter

- [x] Add the incident-shaped case to the existing filter test group and demonstrate its failure before the fix.
- [x] Apply the smallest phrase-filter adjustment and verify incident suppression, retained quiet speech, and unchanged gain/retry behavior.

### 2. Verify the app and responsiveness

- [x] Run the Rust tests, native build, and release-transcription preflight.
- [x] Verify silent-tap output suppression and positive speech controls through the real native flow, capture evidence, and compare release-to-paste latency. Report an exact environment blocker if native automation cannot run.

Native verification limit: quiet spoken “thank you” was transcribed, pasted, and saved in the isolated app. The negative native replay and baseline latency comparison were blocked by TextEdit foreground timeouts. The incident passed local PCM replay; only filter-level latency was measured. Extremely quiet “thank you” remains subject to the existing filter.

### 3. Review and finish

- [x] Complete the fresh final branch review and resolve verified in-scope findings.
- [x] Archive the completed plan and its source diagnosis, commit the finished work, and verify the final branch and working-tree state.

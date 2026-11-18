# Scribe v3 Live in Uttr

Goal: Add ElevenLabs Scribe v3 Live to Uttr's existing model picker for standalone microphone dictation.

Implementation notes: [Scribe v3 Live integration](implementation-notes-scribe-v3-live.md)

Visual mockup: [Models and API Keys](ui-mockup-scribe-v3-live.html)

## Steps

- [x] Commit the verified Fn tap fix separately. Keep private recordings local.
- [x] Add a Scribe card under Cloud Models and an ElevenLabs field under API Keys. Use the existing model switching and secure key storage. Meetings, imports, Ask Selection, and translation use the prior compatible model while Scribe is selected.
- [x] Connect Scribe to standalone dictation. A plain Fn push-to-talk recording can stream after a verified 200 ms hold. Finish on release and use the existing cancel, history, paste, and provider error paths.
- [x] Check model switching and key setup in the rendered settings screens. Use local tests to verify that taps send no audio, the recorder preserves speech samples through release, and cancelled sessions discard their results. Document which recordings use Scribe.
- [ ] With the user operating Uttr, verify silent taps, short speech, long dictation, and cancellation with a configured ElevenLabs key. Compare Fn release to visible paste with Groq on matched public or generated clips. Record median, 95th percentile, and failed trials.

Deliver implementation instruction:
When asked to implement this doc, load the `$deliver` skill, use this file as the approved execution plan, scan every checkbox, and continue through final review, archive movement, commit, and finalization before the final handoff.

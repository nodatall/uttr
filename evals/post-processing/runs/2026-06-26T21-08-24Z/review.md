# Post-Processing Eval Review

Run: 2026-06-26T21-08-24Z
Provider: ollama
Model: qwen3:14b
Dataset: evals/post-processing/golden.jsonl
Started: 2026-06-26T21:08:24.131Z
Finished: 2026-06-26T21:08:52.736Z
Deterministic: 1 passed, 0 failed

## Tag Summary

| tag | total | deterministic failures |
|---|---:|---:|
| preserve-rough-human-wording | 1 | 0 |

## Human Review

Mark each case as pass, borderline, or fail. Deterministic failure does not always mean product failure; it means a strict contract missed.

### preserve-wording-002

Tags: preserve-rough-human-wording
Latency: 28604 ms
Deterministic: PASS

Input:

```text
this is messy but leave it as a note for tomorrow me
```

Output:

```text
This is messy, but leave it as a note for tomorrow me.
```

Human review: [ ] pass  [ ] borderline  [ ] fail

Note:

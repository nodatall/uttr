# BYOK Failure Diagnostics

Goal: Add default-on, failure-only diagnostics for BYOK transcription failures without collecting user content.

Please review this before I start.
Tell me what is wrong, missing, or out of order.

Deliver implementation instruction:
When asked to implement this doc, load the `$deliver` skill, use this file as the approved execution plan, scan every checkbox, and continue through final review, archive movement, commit, and finalization before the final handoff.

## Context

- Backend code lives in `marketing-site`, a Next.js app deployed as one Railway service.
- The desktop app already has a stable install id. BYOK direct-provider users may not always have a backend install token.
- Diagnostics are failure-only for v1. Do not add success analytics in this plan.
- Diagnostics must never include audio, transcript text, prompts, selected text, nearby app context, clipboard contents, API keys, provider response bodies, file names, window titles, document names, or URLs.
- Raw diagnostic events should be stored in Postgres only. Route logs should contain only generic route-health failures, not full event payloads.

Visual mockup: [ui-mockup-byok-failure-diagnostics.html](ui-mockup-byok-failure-diagnostics.html)

## Steps

### 1. Add the backend diagnostics intake

Goal: Store only strict, sanitized BYOK failure metadata.

Decision notes:
- The route should accept a verified install token when present, but should also accept a bounded anonymous install id for BYOK users who have not bootstrapped backend access.
- The route should not treat anonymous install id as authentication. Store a server-side HMAC/hash of the install id and never persist or log the raw value.
- Use a backend-held diagnostic identity secret for hashing. Do not rely on a client secret, and document the required environment variable.
- Store `anonymous_trial_id` only when token-derived identity is valid. Do not store raw `user_id` in the diagnostics table; use a hash or omit it unless implementation evidence shows it is needed.
- The route should reject unknown fields, nested objects, arrays, oversized strings, and oversized bodies so content cannot accidentally enter the payload.

- [x] Add a Postgres `diagnostic_events` migration with seven-day-query-friendly indexes, hashed install identity, optional token-derived internal IDs, and constrained enum-like fields for feature, provider, event, error kind, model bucket, latency bucket, and audio-duration bucket.
- [x] Add a small diagnostics persistence module that hashes identity fields, inserts sanitized rows, and does not accept arbitrary metadata.
- [x] Add `POST /api/diagnostics/event` with strict schema validation, body-size protection, IP and hashed-install rate limiting, optional install-token identity resolution, a server-side kill switch, `204` success responses, and generic server errors.
- [x] Add route tests for valid anonymous events, valid token-derived identity, raw install id not being stored, unknown-field rejection, forbidden-key rejection, invalid-token rejection, body-size rejection, enum validation, kill-switch behavior, and rate-limit response behavior.
- [x] Document the diagnostics identity secret and kill-switch environment variables in the marketing-site environment docs and example env file without adding real secret values.

### 2. Add retention cleanup

Goal: Keep raw diagnostic events for about one week.

- [x] Add a `diagnostics:prune` script that deletes `diagnostic_events` rows older than seven days.
- [x] Add a focused prune test or dry-run-safe check for the deletion query.
- [x] Document the Railway daily schedule command and note that the repo is not currently linked to a Railway project from this checkout until `railway link` is run.
- [x] Treat opportunistic route-side pruning, if added, only as a backup and not as the primary retention mechanism. No opportunistic route-side pruning was added.

### 3. Report BYOK direct-provider failures from the desktop app

Goal: Send fire-and-forget failure events without changing the transcription user experience.

Decision notes:
- Failed diagnostic sends must not block transcription, fallback, or user-facing errors.
- Provider response bodies should be discarded before diagnostics classification.
- Arbitrary provider model strings should be normalized to a known allowlist or `other` before leaving the desktop app.

- [x] Add typed direct-provider error categories in the BYOK Groq/OpenAI transcription client so callers can classify failures without parsing raw messages or carrying provider bodies across the client boundary.
- [x] Add a small desktop diagnostics client that posts to the backend with install id, optional install token, app version, OS, provider, model, event, error kind, status code, latency bucket, and audio-duration bucket.
- [x] Wire diagnostics only around direct BYOK Groq/OpenAI transcription failures, including failures that later fall back locally.
- [x] Add Rust tests for error classification, bucket selection, model normalization, payload construction, provider-body discard behavior, and fire-and-forget send failure not changing transcription flow.

### 4. Update public privacy copy

Goal: Make the default diagnostic collection explicit and narrow.

- [x] Update the marketing-site privacy policy to say Uttr collects short-lived diagnostic metadata to detect and fix failures.
- [x] State that diagnostics do not include audio, transcripts, prompts, selected text, clipboard contents, API keys, or provider response bodies.
- [x] Verify the legal page still renders cleanly after the copy change.

### 5. Validate and prepare for review

- [x] Run focused backend diagnostics route tests.
- [x] Run focused Rust diagnostics/classification tests.
- [x] Run a sentinel leak test where fake provider errors include transcript-like text, a fake API key, a file path, and a URL, then verify none of those values reach the diagnostic payload, backend logs, or database insert.
- [x] Run `npm --prefix marketing-site run lint` and `npm --prefix marketing-site test` if backend TypeScript changed.
- [x] Run `cd src-tauri && cargo test` or the narrowest reliable Rust subset first, then broaden if shared transcription code changed.
- [x] Run the relevant build or smoke check required by `AGENTS.md`, or record the exact blocker if a required check cannot run.

## Validation Evidence

- `npm --prefix marketing-site test -- app/api/diagnostics/event/route.test.ts`
- `npm --prefix marketing-site test -- lib/diagnostics.test.ts scripts/prune-diagnostics.test.mjs`
- `cargo test diagnostics`
- `cargo test direct_status_errors_are_classified_without_provider_body`
- `npm --prefix marketing-site run lint`
- `npm --prefix marketing-site test`
- `cargo test`
- `npm --prefix marketing-site run build`
- Rendered `/legal` through the existing local marketing dev server on port 4317 and captured `output/playwright/legal-diagnostics-full.png`.
- `bun run test:e2e:release-transcribe -- --preflight-only`

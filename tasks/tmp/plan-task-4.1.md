# Sub-task 4.1 Contract

## goal

Make public route rate limiting production-durable and fail closed when the durable limiter is unavailable.

## in_scope

- Add durable rate-limit storage/migration, likely Supabase-backed.
- Add an async production-safe rate-limit helper while preserving existing memory helper for local tests/development.
- Refactor public route callers to use the async helper:
  - `/api/trial/bootstrap`
  - `/api/trial/create-claim`
  - `/api/transcribe/cloud`
- Add tests for local memory fallback, durable-store success/limit behavior, and production durable-store failure.

## out_of_scope

- Checkout/session billing behavior.
- Claim conversion behavior.
- Provider usage quota policy.

## surfaces

- `marketing-site/lib/rate-limit.ts`
- `marketing-site/lib/rate-limit.test.ts`
- `marketing-site/app/api/trial/bootstrap/route.ts`
- `marketing-site/app/api/trial/create-claim/route.ts`
- `marketing-site/app/api/transcribe/cloud/route.ts`
- likely `marketing-site/supabase/migrations/`

## acceptance_checks

- Production mode does not silently use process-local memory.
- Missing/unreachable durable storage in production returns a conservative retryable error from public routes.
- Local/test mode can still use in-memory rate limits.
- Durable limiter consumes limits atomically enough for a route/IP key and returns retry-after information.
- Route callers still return 429 for normal limit exhaustion and do not call downstream expensive work when blocked.

## reference_patterns

- Existing `checkRateLimit` and `rateLimitKeyFromRequest` tests.
- Existing Supabase migration style.
- Existing route handling for rate-limit responses in trial bootstrap, create-claim, and cloud transcription routes.

## test_first_plan

Update `rate-limit.test.ts` first for production fail-closed and durable success behavior, then refactor the helper and routes until those tests pass. If direct route tests are too brittle, test the helper and keep route changes minimal/mechanical.

## verify

- `cd marketing-site && bun test`
- `cd marketing-site && npm run lint`
- later finalization: `cd marketing-site && npm run build`

## trust_boundary_notes

Rate-limit keys derive from request headers at the app boundary. Keep that derivation centralized and document the trusted proxy/header assumption in code or helper naming; do not spread header parsing across routes.

## verification_result

- `cd marketing-site && bun test` passed.
- `cd marketing-site && npm run lint` passed.
- `cd marketing-site && npm run build` passed.

# Repo Sweep 2026-05-21

mode: `$repo-sweep --swarm --preserve-review-artifacts`
review_phase: no-edit audit before fixes
branch: `main`
base: `origin/main`

## Baseline

- `git status --short --branch --untracked-files=all`: `## main...origin/main [ahead 2]`
- `git diff --stat`: no unstaged diff at sweep start.
- `docs/ARCHITECTURE.md`: absent at sweep start.
- Swarm lanes started:
  - Intent and Regression
  - Security and Privacy
  - Performance and Reliability
  - Contracts and Coverage

## Audit Notes

Audit thesis: Uttr's highest-risk shape is the boundary between desktop install
identity/BYOK secrets, hosted cloud-transcription quota, checkout/claim
conversion, and deployment/runtime assumptions. The desktop UI builds, but the
repo still has verified safety-net and production-readiness gaps around those
handoffs.

## Verification Run

- `npm --prefix marketing-site test`: pass, 102 tests.
- `npm run check:translations`: pass, 16 languages complete.
- `npm run lint`: pass.
- `npm --prefix marketing-site run lint`: pass.
- `npm run build`: pass, with Vite large chunk warning.
- `npm --prefix marketing-site run build`: pass.
- `cd src-tauri && cargo test --quiet`: pass, 196 passed, 1 ignored.
- `npm run format:check`: fail. Prettier reports formatting issues in:
  `.playwright-mcp/page-2026-05-21T21-54-35-349Z.yml`,
  `.playwright-mcp/page-2026-05-21T21-55-25-016Z.yml`,
  `.playwright-mcp/page-2026-05-21T21-56-31-260Z.yml`,
  `marketing-site/app/download/route.ts`, `marketing-site/app/page.tsx`,
  `marketing-site/lib/download.ts`, `src/components/ui/Textarea.tsx`,
  `tasks/mockups/session-window-balsamiq.html`.
- `npm run test:playwright`: fail. Two full-system audio settings tests timeout
  at `page.goto("/")`; two smoke tests pass.

## Runtime Probes

Local marketing server was already listening on `localhost:4317`.

- Hostile-origin `POST /api/checkout` with no session: `401`, no
  `Access-Control-Allow-Origin`.
- Hostile-origin `POST /api/billing/portal` with no session: `401`, no
  `Access-Control-Allow-Origin`.
- Hostile-origin `GET /api/entitlement` with no install token: `400`, no
  `Access-Control-Allow-Origin`.
- Hostile-origin invalid Stripe webhook signature: `400`, no
  `Access-Control-Allow-Origin`.
- Hostile-origin `GET /`: `200`, `X-Powered-By: Next.js` present.
- `POST /api/trial/bootstrap` with a synthetic local probe install created an
  install token in the local dev database. No token value is preserved here.

## Accepted Findings

1. BYOK keys are persisted in plain settings and returned to the renderer.
2. IP rate-limit keying trusts the leftmost `X-Forwarded-For` value.
3. Cloud transcription parses multipart bodies before enforcing size when
   `Content-Length` is missing or unreliable.
4. Full-system capture buffers whole sessions in memory.
5. File transcription imports/decodes the whole file before chunking.
6. Model download and provider model-list HTTP calls lack direct timeouts.
7. Playwright full-system audio fixture uses stale/impossible access-state
   values, and the suite currently fails.
8. Recording retention wire values drift between generated bindings and UI/API
   command strings.
9. `npm run format:check` fails on tracked files.
10. PR CI does not compile the production transcription path.
11. Generated Tauri bindings are not regenerated and diff-checked in CI.
12. Critical API routes lack route-level tests.

## Looks Bad But Fine

- Stripe webhook signature verification and durable idempotency are present.
- Checkout requires authenticated session plus redeemed same-user claim token.
- Claim tokens are signed, expiring, and persisted by hash.
- Session cookies are `HttpOnly`, `SameSite=Lax`, and secure in production/HTTPS.
- Recording overlay capability is narrow and separate from the main window.
- No checked-in live-looking secrets were found; ignored local env files contain
  dev secrets and should not be archived.

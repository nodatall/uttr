# Uttr Marketing Site

Standalone Next.js marketing + subscription site for Uttr.

## Stack

- Next.js App Router
- Tailwind CSS
- Procedural canvas-based galaxy renderer for hero
- Stripe Checkout + webhooks
- Postgres for account, access, rate-limit, and webhook state
- Resend for transactional email notifications

## Deployment

- Build the site as a standalone Next.js server with `output: "standalone"`.
- Ship it with the included `Dockerfile`.
- Railway reads `railway.json` and runs `npm run db:migrate` as a pre-deploy command before starting the app.
- The container runs the emitted `server.js` entrypoint.
- Keep the site and backend routes in this one deployment; do not split the proxy into a second service.

## Run Locally

1. Install dependencies:

```bash
npm install
```

2. Copy environment variables:

```bash
cp .env.example .env.local
```

3. Start development server:

```bash
npm run dev
```

## Environment

The site expects these runtime variables:

- `NEXT_PUBLIC_SITE_URL` - public site URL used for redirects and checkout success/cancel links.
- `NEXT_PUBLIC_DOWNLOAD_URL` - public macOS download URL used by marketing and account CTAs. Use `/download` to redirect visitors straight to the latest macOS release asset.
- `NEXT_PUBLIC_SUPPORT_EMAIL` - public support address shown in site UI.
- `NEXT_PUBLIC_STRIPE_PRICE_ID_MONTHLY` - Stripe monthly subscription price ID.
- `NEXT_PUBLIC_AGENTATION_DEV_TOOLBAR` - optional development-only Agentation toolbar toggle; set to `true` when annotating UI.
- `STRIPE_SECRET_KEY` - Stripe server secret for checkout and billing operations.
- `STRIPE_WEBHOOK_SECRET` - Stripe webhook signing secret.
- `DATABASE_URL` - Postgres connection string for accounts, billing access, rate limits, and webhook state.
- `DATABASE_POOL_MAX` - optional Postgres pool size; defaults to `5`.
- `GROQ_API_KEY` - server-held Groq key for default cloud transcription proxying.
- `GROQ_TRANSCRIPTION_MODEL_DEFAULT` - optional default Groq transcription model name.
- `OPENAI_API_KEY` - server-held OpenAI key for live session summaries.
- `OPENAI_SESSION_SUMMARY_MODEL` - optional OpenAI model override for session summaries.
- `UTTR_PRO_DAILY_AUDIO_SECONDS_LIMIT` - optional Pro rolling 24-hour audio cap in seconds; defaults to `18000` (5 hours).
- `UTTR_PRO_DAILY_REQUEST_LIMIT` - optional Pro rolling 24-hour transcription and summary request cap; defaults to `500`.
- `UTTR_PRO_BURST_REQUEST_LIMIT` - optional Pro burst transcription and summary request cap; defaults to `60`.
- `UTTR_PRO_BURST_WINDOW_SECONDS` - optional Pro burst window in seconds; defaults to `600` (10 minutes).
- `UTTR_INSTALL_TOKEN_SECRET` - signing secret for install tokens.
- `UTTR_CLAIM_TOKEN_SECRET` - signing secret for claim tokens.
- `UTTR_SESSION_SECRET` - signing secret for account sessions.
- `RESEND_API_KEY` - optional email provider secret for transactional mail.
- `EMAIL_FROM` - optional sender identity for transactional mail.
- `EMAIL_SUPPORT` - optional support mailbox override for transactional mail.

Copy `.env.example` to `.env.local` for development. Production should provide the same variables through Railway service variables or shared variables.

Apply database migrations before running the purchase/account routes:

```bash
npm run db:migrate
```

## Stripe Setup

1. Create product `Uttr Pro` in Stripe.
2. Create recurring monthly price `$5.00` and place the ID in `NEXT_PUBLIC_STRIPE_PRICE_ID_MONTHLY`.
3. Set webhook endpoint to:

```text
http://localhost:3000/api/stripe/webhook
```

4. Subscribe webhook events:

- `checkout.session.completed`
- `invoice.paid`
- `invoice.payment_failed`
- `customer.subscription.updated`
- `customer.subscription.deleted`

5. For local testing with Stripe CLI:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

Copy the emitted signing secret to `STRIPE_WEBHOOK_SECRET`.

## Routes

- `/` landing page
- `/account` account and subscription page
- `/claim` anonymous install claim page
- `/download` redirect to the latest macOS release download
- `/legal` legal page
- `/success` checkout success page
- `/cancel` checkout cancellation page
- `GET /api/auth/session` read the current signed-in account session
- `POST /api/auth/signin` sign in with an email/password account
- `POST /api/auth/signup` create an email/password account
- `POST /api/auth/signout` clear the account session
- `POST /api/auth/convert-anonymous` link an anonymous trial to an account
- `POST /api/billing/portal` create a Stripe billing portal session
- `POST /api/checkout` create Stripe checkout session
- `GET /api/entitlement` resolve install entitlement and trial state
- `POST /api/session/summary` summarize a live session transcript chunk set
- `POST /api/stripe/webhook` process Stripe webhooks
- `POST /api/transcribe/cloud` proxy default cloud transcription
- `POST /api/trial/bootstrap` create or refresh an anonymous install trial
- `POST /api/trial/create-claim` create an anonymous trial claim token

## Notes

- The desktop app enforces entitlement through install tokens and server access snapshots.
- Webhook idempotency, production rate limiting, trial state, usage accounting, and account sessions are durable Postgres writes.
- Cloud transcription and session summary routes use server-held provider keys and count successful provider calls against request usage limits.

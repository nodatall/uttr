# Uttr Marketing Site

Standalone Next.js marketing + subscription site for Uttr.

## Stack
- Next.js App Router
- Tailwind CSS
- Procedural canvas-based galaxy renderer for hero
- Stripe Checkout + webhooks
- Resend for transactional email notifications

## Deployment

- Build the site as a standalone Next.js server with `output: "standalone"`.
- Ship it with the included `Dockerfile` and `fly.toml`.
- Fly listens on port `3000` and runs the emitted `server.js` entrypoint.
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
- `NEXT_PUBLIC_DOWNLOAD_URL` - public macOS download URL used by marketing and account CTAs.
- `NEXT_PUBLIC_SUPPORT_EMAIL` - public support address shown in site UI.
- `NEXT_PUBLIC_STRIPE_PRICE_ID_MONTHLY` - Stripe monthly subscription price ID.
- `STRIPE_SECRET_KEY` - Stripe server secret for checkout and billing operations.
- `STRIPE_WEBHOOK_SECRET` - Stripe webhook signing secret.
- `SUPABASE_URL` - Supabase project URL for billing and access storage.
- `SUPABASE_ANON_KEY` - Supabase anon key for browser-safe reads where needed.
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase service-role key for privileged backend writes.
- `GROQ_API_KEY` - server-held Groq key for default cloud transcription proxying.
- `GROQ_TRANSCRIPTION_MODEL_DEFAULT` - default Groq transcription model name.
- `UTTR_INSTALL_TOKEN_SECRET` - signing secret for install tokens.
- `UTTR_CLAIM_TOKEN_SECRET` - signing secret for claim tokens.
- `RESEND_API_KEY` - optional email provider secret for transactional mail.
- `EMAIL_FROM` - optional sender identity for transactional mail.
- `EMAIL_SUPPORT` - optional support mailbox override for transactional mail.

Copy `.env.example` to `.env.local` for development. Production should provide the same variables through Fly secrets and app configuration.

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
- `/success` checkout success page
- `/cancel` checkout cancellation page
- `POST /api/checkout` create Stripe checkout session
- `POST /api/stripe/webhook` process Stripe webhooks

## Notes
- The app is purchase-enabled and does not enforce in-app entitlement checks.
- Webhook idempotency is implemented in-memory for this deployment unit.
- The backend proxy and entitlement work will add additional routes under `/api/*` in later tasks.

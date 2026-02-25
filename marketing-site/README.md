# Uttr Marketing Site

Standalone Next.js marketing + subscription site for Uttr.

## Stack
- Next.js App Router
- Tailwind CSS
- Procedural canvas-based galaxy renderer for hero
- Stripe Checkout + webhooks
- Resend for transactional email notifications

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

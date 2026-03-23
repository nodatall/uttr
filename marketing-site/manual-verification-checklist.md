# Manual Verification Checklist

- First-run trial start: verify a fresh install can boot, submit one proxy transcription, and flip to `trialing` on the backend without requiring a visible key.
- Expired paywall: verify an expired unpaid install is blocked, gets routed into the claim flow, and does not continue transcribing locally unless fallback is explicitly allowed for active access.
- Checkout unlock: verify the claim-to-checkout journey returns to the app and refreshes entitlement after Stripe payment succeeds.
- Durable webhook handling: verify a repeated Stripe webhook delivery is ignored as a duplicate and does not double-apply entitlement changes.
- Proxy latency telemetry: verify the cloud transcription response includes timing fields and the logs show the backend timing breakdown for a real request.

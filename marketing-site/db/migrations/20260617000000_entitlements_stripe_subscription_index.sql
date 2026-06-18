create index if not exists entitlements_stripe_subscription_id_idx
  on public.entitlements (stripe_subscription_id)
  where stripe_subscription_id is not null;

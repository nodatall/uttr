create extension if not exists pgcrypto;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  password_hash text not null,
  byok_unlocked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists profiles_email_lower_idx
  on public.profiles (lower(email));

create table if not exists public.anonymous_trials (
  id uuid primary key default gen_random_uuid(),
  install_id text not null unique,
  device_fingerprint_hash text not null,
  user_id uuid null references public.profiles (id) on delete set null,
  status text not null default 'new',
  trial_started_at timestamptz null,
  trial_ends_at timestamptz null,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint anonymous_trials_status_check
    check (status in ('new', 'trialing', 'expired', 'linked'))
);

create index if not exists anonymous_trials_user_id_idx
  on public.anonymous_trials (user_id);

create index if not exists anonymous_trials_status_idx
  on public.anonymous_trials (status);

create index if not exists anonymous_trials_trial_ends_at_idx
  on public.anonymous_trials (trial_ends_at);

create table if not exists public.trial_claims (
  id uuid primary key default gen_random_uuid(),
  anonymous_trial_id uuid not null references public.anonymous_trials (id) on delete cascade,
  claim_token_hash text not null unique,
  expires_at timestamptz not null,
  redeemed_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists trial_claims_anonymous_trial_id_idx
  on public.trial_claims (anonymous_trial_id);

create index if not exists trial_claims_expires_at_idx
  on public.trial_claims (expires_at);

create table if not exists public.entitlements (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  subscription_status text not null default 'inactive',
  stripe_customer_id text null,
  stripe_subscription_id text null,
  current_period_ends_at timestamptz null,
  updated_at timestamptz not null default now(),
  constraint entitlements_subscription_status_check
    check (subscription_status in ('inactive', 'active', 'past_due', 'canceled', 'expired'))
);

create index if not exists entitlements_subscription_status_idx
  on public.entitlements (subscription_status);

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  anonymous_trial_id uuid null references public.anonymous_trials (id) on delete set null,
  user_id uuid null references public.profiles (id) on delete set null,
  source text not null,
  audio_seconds integer not null,
  created_at timestamptz not null default now(),
  constraint usage_events_source_check
    check (source in ('cloud_default', 'cloud_byok', 'local_fallback')),
  constraint usage_events_audio_seconds_check
    check (audio_seconds >= 0)
);

create index if not exists usage_events_anonymous_trial_id_idx
  on public.usage_events (anonymous_trial_id);

create index if not exists usage_events_user_id_idx
  on public.usage_events (user_id);

create index if not exists usage_events_created_at_idx
  on public.usage_events (created_at desc);

create table if not exists public.checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  checkout_context_key text not null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  anonymous_trial_id uuid null references public.anonymous_trials (id) on delete set null,
  install_id text null,
  stripe_checkout_session_id text not null unique,
  stripe_customer_id text null,
  status text not null default 'open',
  checkout_url text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint checkout_sessions_status_check
    check (status in ('open', 'completed', 'expired'))
);

create unique index if not exists checkout_sessions_open_context_key_idx
  on public.checkout_sessions (checkout_context_key)
  where status = 'open';

create index if not exists checkout_sessions_user_id_idx
  on public.checkout_sessions (user_id);

create index if not exists checkout_sessions_anonymous_trial_id_idx
  on public.checkout_sessions (anonymous_trial_id);

create index if not exists checkout_sessions_install_id_idx
  on public.checkout_sessions (install_id);

create index if not exists checkout_sessions_status_idx
  on public.checkout_sessions (status);

create index if not exists checkout_sessions_expires_at_idx
  on public.checkout_sessions (expires_at);

create table if not exists public.rate_limit_buckets (
  rate_limit_key text primary key,
  count integer not null,
  reset_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.stripe_webhook_events (
  id text primary key,
  event_type text not null,
  status text not null default 'processed',
  processed_at timestamptz null,
  processing_started_at timestamptz null,
  last_error text null,
  updated_at timestamptz not null default now(),
  constraint stripe_webhook_events_status_check
    check (status in ('processing', 'processed', 'failed'))
);

create index if not exists stripe_webhook_events_event_type_idx
  on public.stripe_webhook_events (event_type);

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
  before update on public.profiles
  for each row
  execute function public.touch_updated_at();

drop trigger if exists set_anonymous_trials_updated_at on public.anonymous_trials;
create trigger set_anonymous_trials_updated_at
  before update on public.anonymous_trials
  for each row
  execute function public.touch_updated_at();

drop trigger if exists set_entitlements_updated_at on public.entitlements;
create trigger set_entitlements_updated_at
  before update on public.entitlements
  for each row
  execute function public.touch_updated_at();

drop trigger if exists set_checkout_sessions_updated_at on public.checkout_sessions;
create trigger set_checkout_sessions_updated_at
  before update on public.checkout_sessions
  for each row
  execute function public.touch_updated_at();

drop trigger if exists set_rate_limit_buckets_updated_at on public.rate_limit_buckets;
create trigger set_rate_limit_buckets_updated_at
  before update on public.rate_limit_buckets
  for each row
  execute function public.touch_updated_at();

drop trigger if exists set_stripe_webhook_events_updated_at on public.stripe_webhook_events;
create trigger set_stripe_webhook_events_updated_at
  before update on public.stripe_webhook_events
  for each row
  execute function public.touch_updated_at();

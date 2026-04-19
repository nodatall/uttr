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

alter table public.checkout_sessions enable row level security;

drop trigger if exists set_checkout_sessions_updated_at on public.checkout_sessions;
create trigger set_checkout_sessions_updated_at
  before update on public.checkout_sessions
  for each row
  execute function public.touch_updated_at();

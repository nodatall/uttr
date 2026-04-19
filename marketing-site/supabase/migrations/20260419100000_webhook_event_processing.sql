alter table public.stripe_webhook_events
  add column if not exists status text;

update public.stripe_webhook_events
   set status = 'processed'
 where status is null;

alter table public.stripe_webhook_events
  alter column status set default 'processed',
  alter column status set not null,
  add column if not exists processing_started_at timestamptz null,
  add column if not exists last_error text null,
  add column if not exists updated_at timestamptz null;

update public.stripe_webhook_events
   set updated_at = coalesce(updated_at, processed_at, now())
 where updated_at is null;

alter table public.stripe_webhook_events
  alter column updated_at set default now(),
  alter column updated_at set not null,
  alter column processed_at drop default,
  alter column processed_at drop not null;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'stripe_webhook_events_status_check'
       and conrelid = 'public.stripe_webhook_events'::regclass
  ) then
    alter table public.stripe_webhook_events
      add constraint stripe_webhook_events_status_check
        check (status in ('processing', 'processed', 'failed'));
  end if;
end;
$$;

create or replace function public.begin_stripe_webhook_event(
  p_event_id text,
  p_event_type text,
  p_stale_after_seconds integer default 600
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_id text;
  event_row public.stripe_webhook_events%rowtype;
  stale_after interval := greatest(p_stale_after_seconds, 1) * interval '1 second';
  now_ts timestamptz := now();
begin
  insert into public.stripe_webhook_events (
    id,
    event_type,
    status,
    processing_started_at,
    processed_at,
    last_error,
    updated_at
  )
  values (
    p_event_id,
    p_event_type,
    'processing',
    now_ts,
    null,
    null,
    now_ts
  )
  on conflict (id) do nothing
  returning id into inserted_id;

  if inserted_id is not null then
    return 'process';
  end if;

  select *
    into event_row
    from public.stripe_webhook_events
   where id = p_event_id
   for update;

  if event_row.status = 'processed' then
    return 'duplicate';
  end if;

  if event_row.status = 'processing'
     and event_row.processing_started_at is not null
     and event_row.processing_started_at > now_ts - stale_after then
    return 'in_progress';
  end if;

  update public.stripe_webhook_events
     set event_type = p_event_type,
         status = 'processing',
         processing_started_at = now_ts,
         processed_at = null,
         last_error = null,
         updated_at = now_ts
   where id = p_event_id;

  return 'process';
end;
$$;

create or replace function public.complete_stripe_webhook_event(
  p_event_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.stripe_webhook_events
     set status = 'processed',
         processed_at = now(),
         processing_started_at = null,
         last_error = null,
         updated_at = now()
   where id = p_event_id;
end;
$$;

create or replace function public.fail_stripe_webhook_event(
  p_event_id text,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.stripe_webhook_events
     set status = 'failed',
         processing_started_at = null,
         last_error = left(coalesce(p_error, 'Unknown webhook processing error'), 2000),
         updated_at = now()
   where id = p_event_id;
end;
$$;

revoke all on function public.begin_stripe_webhook_event(text, text, integer) from public, anon, authenticated;
revoke all on function public.complete_stripe_webhook_event(text) from public, anon, authenticated;
revoke all on function public.fail_stripe_webhook_event(text, text) from public, anon, authenticated;

grant execute on function public.begin_stripe_webhook_event(text, text, integer) to service_role;
grant execute on function public.complete_stripe_webhook_event(text) to service_role;
grant execute on function public.fail_stripe_webhook_event(text, text) to service_role;

drop trigger if exists set_stripe_webhook_events_updated_at on public.stripe_webhook_events;
create trigger set_stripe_webhook_events_updated_at
  before update on public.stripe_webhook_events
  for each row
  execute function public.touch_updated_at();

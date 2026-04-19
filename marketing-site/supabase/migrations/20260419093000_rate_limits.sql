create table if not exists public.rate_limit_buckets (
  rate_limit_key text primary key,
  count integer not null,
  reset_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create or replace function public.consume_rate_limit(
  p_rate_limit_key text,
  p_limit integer,
  p_window_ms integer
)
returns table (
  allowed boolean,
  remaining integer,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_bucket public.rate_limit_buckets%rowtype;
  window_interval interval := p_window_ms * interval '1 millisecond';
  now_ts timestamptz := now();
begin
  if p_limit <= 0 then
    return query select false, 0, greatest(1, ceil(extract(epoch from window_interval)))::integer;
    return;
  end if;

  insert into public.rate_limit_buckets as rate_limit_buckets (
    rate_limit_key,
    count,
    reset_at,
    updated_at
  )
  values (
    p_rate_limit_key,
    1,
    now_ts + window_interval,
    now_ts
  )
  on conflict (rate_limit_key) do update
    set count = case
      when rate_limit_buckets.reset_at <= now_ts then 1
      else rate_limit_buckets.count + 1
    end,
    reset_at = case
      when rate_limit_buckets.reset_at <= now_ts then now_ts + window_interval
      else rate_limit_buckets.reset_at
    end,
    updated_at = now_ts
  returning * into current_bucket;

  if current_bucket.count > p_limit then
    return query select false, 0, greatest(1, ceil(extract(epoch from (current_bucket.reset_at - now_ts))))::integer;
    return;
  end if;

  return query select true, greatest(p_limit - current_bucket.count, 0), 0;
end;
$$;

revoke all on function public.consume_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, integer, integer) to service_role;

alter table public.rate_limit_buckets enable row level security;

drop trigger if exists set_rate_limit_buckets_updated_at on public.rate_limit_buckets;
create trigger set_rate_limit_buckets_updated_at
  before update on public.rate_limit_buckets
  for each row
  execute function public.touch_updated_at();

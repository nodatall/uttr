create index if not exists usage_events_anonymous_trial_created_at_idx
  on public.usage_events (anonymous_trial_id, created_at desc)
  where anonymous_trial_id is not null;

create index if not exists usage_events_user_created_at_idx
  on public.usage_events (user_id, created_at desc)
  where user_id is not null;

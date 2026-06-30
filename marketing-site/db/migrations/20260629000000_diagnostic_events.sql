create table if not exists public.diagnostic_events (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  install_id_hash text not null,
  anonymous_trial_id uuid null references public.anonymous_trials (id) on delete set null,
  user_id_hash text null,
  app_version text not null,
  os_name text not null,
  os_version_bucket text not null,
  feature text not null,
  provider text not null,
  model_id text not null,
  event text not null,
  error_kind text not null,
  http_status integer null,
  latency_bucket text not null,
  audio_duration_bucket text not null,
  constraint diagnostic_events_install_hash_check
    check (char_length(install_id_hash) = 64),
  constraint diagnostic_events_user_hash_check
    check (user_id_hash is null or char_length(user_id_hash) = 64),
  constraint diagnostic_events_app_version_check
    check (char_length(app_version) between 1 and 64),
  constraint diagnostic_events_os_name_check
    check (os_name in ('macos', 'windows', 'linux', 'unknown')),
  constraint diagnostic_events_os_version_bucket_check
    check (os_version_bucket in ('unknown', 'pre_13', '13', '14', '15', '16_plus')),
  constraint diagnostic_events_feature_check
    check (feature in ('transcription')),
  constraint diagnostic_events_provider_check
    check (provider in ('byok_groq', 'byok_openai')),
  constraint diagnostic_events_model_id_check
    check (model_id in ('whisper-large-v3', 'whisper-large-v3-turbo', 'gpt-4o-transcribe', 'other')),
  constraint diagnostic_events_event_check
    check (event in ('byok_transcription_failed')),
  constraint diagnostic_events_error_kind_check
    check (error_kind in (
      'auth_failed',
      'rate_limited',
      'quota_exceeded',
      'provider_4xx',
      'provider_5xx',
      'timeout',
      'network_error',
      'parse_failed',
      'payload_too_large',
      'unsupported_feature',
      'missing_api_key',
      'request_failed',
      'unknown'
    )),
  constraint diagnostic_events_http_status_check
    check (http_status is null or (http_status >= 100 and http_status <= 599)),
  constraint diagnostic_events_latency_bucket_check
    check (latency_bucket in ('lt_1s', '1_3s', '3_10s', '10_30s', '30s_plus')),
  constraint diagnostic_events_audio_duration_bucket_check
    check (audio_duration_bucket in ('0_5s', '5_15s', '15_30s', '30_60s', '60s_plus'))
);

create index if not exists diagnostic_events_received_at_idx
  on public.diagnostic_events (received_at desc);

create index if not exists diagnostic_events_install_received_at_idx
  on public.diagnostic_events (install_id_hash, received_at desc);

create index if not exists diagnostic_events_provider_error_received_at_idx
  on public.diagnostic_events (provider, error_kind, received_at desc);

create index if not exists diagnostic_events_model_error_received_at_idx
  on public.diagnostic_events (model_id, error_kind, received_at desc);

create index if not exists diagnostic_events_app_provider_received_at_idx
  on public.diagnostic_events (app_version, provider, received_at desc);

create index if not exists diagnostic_events_os_provider_received_at_idx
  on public.diagnostic_events (os_name, os_version_bucket, provider, received_at desc);

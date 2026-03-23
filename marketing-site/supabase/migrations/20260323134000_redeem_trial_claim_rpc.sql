create or replace function public.redeem_trial_claim(
  p_claim_token_hash text,
  p_user_id uuid
)
returns public.anonymous_trials
language plpgsql
security definer
set search_path = public
as $$
declare
  claim_row public.trial_claims%rowtype;
  trial_row public.anonymous_trials%rowtype;
begin
  select *
    into claim_row
    from public.trial_claims
   where claim_token_hash = p_claim_token_hash
   limit 1;

  if not found then
    raise exception 'Claim token not found' using errcode = 'P0002';
  end if;

  if claim_row.redeemed_at is not null then
    raise exception 'Claim token already redeemed' using errcode = 'P0001';
  end if;

  if claim_row.expires_at <= now() then
    raise exception 'Claim token expired' using errcode = 'P0001';
  end if;

  update public.trial_claims
     set redeemed_at = now()
   where id = claim_row.id
     and redeemed_at is null
   returning *
      into claim_row;

  if not found then
    raise exception 'Claim token already redeemed' using errcode = 'P0001';
  end if;

  update public.anonymous_trials
     set user_id = p_user_id,
         status = 'linked',
         updated_at = now()
   where id = claim_row.anonymous_trial_id
     and (user_id is null or user_id = p_user_id)
   returning *
      into trial_row;

  if not found then
    raise exception 'Claim token already linked to a different user' using errcode = 'P0001';
  end if;

  return trial_row;
end;
$$;

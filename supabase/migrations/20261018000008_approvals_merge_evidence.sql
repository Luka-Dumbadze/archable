-- supabase/migrations/20261018000008_approvals_merge_evidence.sql (PROGRESS.md Q11)
-- A decision used to replace approvals.evidence with the press evidence, dropping what the card was issued with:
-- { rationale_digest, summary } (plan §7.3). Both functions now merge (existing || new; the new keys win).
-- The bodies are unchanged otherwise; create or replace keeps their grants.

create or replace function public.consume_telegram_approval(
  p_nonce_hash bytea, p_tg_user bigint, p_chat bigint, p_message integer, p_decision text, p_evidence jsonb)
returns table (outcome text, approval_id uuid, change_request_id uuid, head_sha text)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  a public.approvals%rowtype;
  m public.memberships%rowtype;
begin
  if p_decision not in ('approve', 'reject') then
    raise exception 'decision must be approve or reject' using errcode = '22023';
  end if;
  select * into a from public.approvals x where x.nonce_hash = p_nonce_hash for update;
  if not found then
    return query select 'unknown'::text, null::uuid, null::uuid, null::text;
    return;
  end if;
  select * into m from public.memberships x where x.id = a.approver;
  if m.tg_user_id is distinct from p_tg_user or m.revoked_at is not null then
    outcome := 'wrong_person';
  elsif a.tg_chat_id is distinct from p_chat or a.tg_message_id is distinct from p_message then
    outcome := 'wrong_message';
  elsif a.status <> 'pending' then
    outcome := a.status;                                  -- already decided, expired or superseded
  elsif a.expires_at < now() then
    update public.approvals x set status = 'expired' where x.id = a.id;
    outcome := 'expired';
  elsif a.step_up and p_decision = 'approve' then
    outcome := 'step_up_required';                        -- T3/T4: only the Mini App can approve
  else
    update public.approvals x
       set status = case p_decision when 'approve' then 'approved' else 'rejected' end,
           decided_at = now(), evidence = coalesce(x.evidence, '{}'::jsonb) || coalesce(p_evidence, '{}'::jsonb)
     where x.id = a.id;
    outcome := case p_decision when 'approve' then 'approved' else 'rejected' end;
  end if;
  return query select outcome, a.id, a.change_request_id, a.head_sha;
end
$$;


create or replace function public.complete_typed_confirmation(
  p_tg_user bigint, p_chat bigint, p_code_hash bytea, p_evidence jsonb)
returns table (outcome text, approval_id uuid, change_request_id uuid, head_sha text)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  c private.approval_challenges%rowtype;
  a public.approvals%rowtype;
begin
  select * into c from private.approval_challenges x
   where x.tg_user_id = p_tg_user and x.status = 'open' for update;
  if not found then
    return query select 'no_challenge'::text, null::uuid, null::uuid, null::text;
    return;
  end if;
  select * into a from public.approvals x where x.id = c.approval_id for update;
  if c.tg_chat_id <> p_chat then
    outcome := 'wrong_chat';
  elsif c.expires_at < now() then
    update private.approval_challenges x set status = 'expired' where x.id = c.id;
    outcome := 'challenge_expired';
  elsif c.code_hash <> p_code_hash then
    update private.approval_challenges x
       set attempts = x.attempts + 1,
           status = case when x.attempts + 1 >= 5 then 'expired' else 'open' end
     where x.id = c.id;
    outcome := 'wrong_code';
  elsif a.status <> 'pending' then
    update private.approval_challenges x set status = 'superseded' where x.id = c.id;
    outcome := a.status;
  elsif a.expires_at < now() then
    update public.approvals x set status = 'expired' where x.id = a.id;
    update private.approval_challenges x set status = 'expired' where x.id = c.id;
    outcome := 'expired';
  else
    update private.approval_challenges x set status = 'used' where x.id = c.id;
    update public.approvals x
       set status = 'approved', channel = 'telegram_typed', decided_at = now(), evidence = coalesce(x.evidence, '{}'::jsonb) || coalesce(p_evidence, '{}'::jsonb)
     where x.id = a.id;
    outcome := 'approved';
  end if;
  return query select outcome, a.id, a.change_request_id, a.head_sha;
end
$$;


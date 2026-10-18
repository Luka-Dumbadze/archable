-- supabase/migrations/20261018000009_owner_refs_governance_lookups.sql (P4.D2.7, PROGRESS.md Q9 (2), (3))
-- The lookups the governance deps need before a tenant context exists, as definer functions for the control plane:
--   owner_refs        the single-use 22-character refs behind the owner's post buttons (Draft it, Not this, Undo):
--                     Telegram's callback_data holds 64 bytes, so a button carries a ref, never its payload.
--   take_owner_ref    resolves a ref once, for the owner it was minted for, before it expires.
--   approval_summary  the exact card text an approval was issued with (ArchableBotDeps.approvalSummary).
--   tenant_for_repo   the tenant behind a GitHub webhook (installation + repository).

create table private.owner_refs (
  ref           text primary key check (ref ~ '^[A-Za-z0-9_-]{22}$'),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  membership_id uuid not null references public.memberships (id) on delete cascade,
  action        text not null check (action in ('draft_desire', 'decline_desire', 'undo')),
  payload       jsonb not null default '{}',
  expires_at    timestamptz not null,
  used_at       timestamptz,
  created_at    timestamptz not null default now()
);
grant insert on private.owner_refs to archable_control;

create function private.take_owner_ref(p_ref text, p_tg_user bigint)
returns table (outcome text, tenant_id uuid, membership_id uuid, action text, payload jsonb)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  r private.owner_refs%rowtype;
  m public.memberships%rowtype;
begin
  select * into r from private.owner_refs x where x.ref = p_ref for update;
  if not found then
    return query select 'unknown'::text, null::uuid, null::uuid, null::text, null::jsonb;
    return;
  end if;
  select * into m from public.memberships x where x.id = r.membership_id;
  if m.tg_user_id is distinct from p_tg_user or m.revoked_at is not null then outcome := 'not_yours';
  elsif r.used_at is not null then outcome := 'used';
  elsif r.expires_at < now() then outcome := 'expired';
  else
    update private.owner_refs x set used_at = now() where x.ref = r.ref;
    outcome := 'ok';
  end if;
  return query select outcome, r.tenant_id, r.membership_id, r.action, r.payload;
end
$$;

create function private.approval_summary(p_approval uuid)
returns text
language sql stable security definer set search_path = ''
as $$ select a.evidence ->> 'summary' from public.approvals a where a.id = p_approval $$;

create function private.tenant_for_repo(p_installation bigint, p_repo text)
returns uuid
language sql stable security definer set search_path = ''
as $$ select t.id from public.tenants t where t.installation_id = p_installation and t.repo_full_name = p_repo $$;

revoke execute on function private.take_owner_ref(text, bigint), private.approval_summary(uuid),
                           private.tenant_for_repo(bigint, text) from public, anon, authenticated;
grant execute on function private.take_owner_ref(text, bigint), private.approval_summary(uuid),
                          private.tenant_for_repo(bigint, text) to archable_control;

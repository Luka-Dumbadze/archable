-- supabase/migrations/20261018000014_owner_refs_for_member.sql (P5.D2.3)
-- The web posts the same buttons as Telegram (plan §8.4: POST /v1/owner/press with body.ref). There the caller is a
-- Supabase session's membership, not a Telegram user, so the ref is checked against the membership it was minted for.
-- Same rules as take_owner_ref: single use, before it expires.
create function private.take_owner_ref_for_member(p_ref text, p_membership uuid)
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
  if r.membership_id is distinct from p_membership or m.revoked_at is not null then outcome := 'not_yours';
  elsif r.used_at is not null then outcome := 'used';
  elsif r.expires_at < now() then outcome := 'expired';
  else
    update private.owner_refs x set used_at = now() where x.ref = r.ref;
    outcome := 'ok';
  end if;
  return query select outcome, r.tenant_id, r.membership_id, r.action, r.payload;
end
$$;

revoke execute on function private.take_owner_ref_for_member(text, uuid) from public, anon, authenticated;
grant execute on function private.take_owner_ref_for_member(text, uuid) to archable_control;

-- supabase/migrations/20261018000003_owner_tenants.sql
-- @ArchableBot's /web, /connect and Business flows ask which tenants a Telegram user owns, before any tenant context
-- exists (ArchableBotDeps.ownerTenants). Like private.resolve_bot_hook, this definer function returns exactly that:
-- the user's live owner memberships on live or provisioning tenants.
create function private.owner_tenants(p_tg_user bigint)
returns table (tenant_id uuid, slug text, os_name text, membership_id uuid)
language sql stable security definer set search_path = ''
as $$
  select t.id, t.slug, t.os_name, m.id
    from public.memberships m
    join public.tenants t on t.id = m.tenant_id and t.status in ('live', 'provisioning')
   where m.tg_user_id = p_tg_user and m.role = 'owner' and m.revoked_at is null
   order by t.slug
$$;

revoke execute on function private.owner_tenants(bigint) from public, anon, authenticated;
grant execute on function private.owner_tenants(bigint) to archable_control;

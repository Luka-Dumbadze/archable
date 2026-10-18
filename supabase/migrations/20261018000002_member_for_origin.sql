-- supabase/migrations/20261018000002_member_for_origin.sql
-- auth.ts (plan §5.6) resolves a shell caller's membership from the JWT subject and the request's origin, before any
-- tenant context exists, and the plane roles see nothing without one. Like private.resolve_bot_hook, this definer
-- function returns exactly what routing needs: one live membership on one live tenant, or nothing.
create function private.member_for(p_user uuid, p_slug text, p_custom_domain text)
returns table (tenant_id uuid, membership_id uuid, role text)
language sql stable security definer set search_path = ''
as $$
  select m.tenant_id, m.id, m.role
    from public.memberships m
    join public.tenants t on t.id = m.tenant_id and t.status = 'live'
   where m.user_id = p_user and m.revoked_at is null
     and ((p_slug is not null and t.slug = p_slug) or (p_custom_domain is not null and t.custom_domain = p_custom_domain))
$$;

revoke execute on function private.member_for(uuid, text, text) from public, anon, authenticated;
grant execute on function private.member_for(uuid, text, text) to archable_runtime;

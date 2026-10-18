-- supabase/migrations/20261018000005_web_chat_for.sql
-- GET /v1/widget/config/:slug (plan §6.5) starts from a public slug, before any tenant context. Like
-- private.resolve_bot_hook, this definer function returns exactly what the route needs: the tenant and its active
-- bundle, only when the tenant is live and web chat is on (the same rule open_web_session applies).
create function private.web_chat_for(p_slug text)
returns table (tenant_id uuid, active_digest text)
language sql stable security definer set search_path = ''
as $$
  select t.id, t.active_digest
    from public.tenants t
    join public.channel_connections c on c.tenant_id = t.id and c.kind = 'web' and c.status = 'live'
   where t.slug = p_slug and t.status = 'live' and t.active_digest is not null
$$;

revoke execute on function private.web_chat_for(text) from public, anon, authenticated;
grant execute on function private.web_chat_for(text) to archable_runtime;

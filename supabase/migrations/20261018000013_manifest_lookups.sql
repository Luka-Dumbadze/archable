-- supabase/migrations/20261018000013_manifest_lookups.sql (P5.D2.1, v3 §2.4)
-- GET /v1/manifest is answered before any sign-in, keyed by the browser-set Origin: by slug (prod: the active digest;
-- pr-<n>: that PR's change_requests.bundle_digest) or by custom domain. The runtime plane has no tenant context
-- yet, so these definer functions return exactly the manifest's facts, for live tenants only.
create function private.manifest_for(p_slug text, p_pr integer)
returns table (tenant_id uuid, slug text, os_name text, digest text, epoch bigint, theme jsonb, extension_digest text)
language sql stable security definer set search_path = ''
as $$
  select t.id, t.slug, t.os_name, d.digest, t.epoch, s.bundle -> 'ui' -> 'theme', s.extension_digest
    from public.tenants t
    cross join lateral (
      select case when p_pr is null then t.active_digest
                  else (select c.bundle_digest from public.change_requests c
                         where c.tenant_id = t.id and c.pr_number = p_pr and c.state not in ('merged', 'closed', 'superseded'))
             end as digest) d
    join public.specs s on s.tenant_id = t.id and s.digest = d.digest
   where t.slug = p_slug and t.status = 'live'
$$;

create function private.manifest_for_domain(p_host text)
returns table (tenant_id uuid, slug text, os_name text, digest text, epoch bigint, theme jsonb, extension_digest text)
language sql stable security definer set search_path = ''
as $$
  select t.id, t.slug, t.os_name, t.active_digest, t.epoch, s.bundle -> 'ui' -> 'theme', s.extension_digest
    from public.tenants t
    join public.specs s on s.tenant_id = t.id and s.digest = t.active_digest
   where t.custom_domain = p_host and t.status = 'live'
$$;

revoke execute on function private.manifest_for(text, integer), private.manifest_for_domain(text) from public, anon, authenticated;
grant execute on function private.manifest_for(text, integer), private.manifest_for_domain(text) to archable_runtime;

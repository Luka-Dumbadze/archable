-- supabase/migrations/20261018000010_change_request_tenant.sql (P4.D2.7)
-- settle(changeRequestId) is called by @ArchableBot after a decision, with the change's id only (ArchableBotDeps.settle);
-- the control plane sees no tenant before its context is set, so this definer function names the tenant.
create function private.change_request_tenant(p_change_request uuid)
returns uuid
language sql stable security definer set search_path = ''
as $$ select c.tenant_id from public.change_requests c where c.id = p_change_request $$;

revoke execute on function private.change_request_tenant(uuid) from public, anon, authenticated;
grant execute on function private.change_request_tenant(uuid) to archable_control;

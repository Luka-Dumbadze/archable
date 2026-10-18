-- supabase/migrations/20261018000004_tenant_secrets_on_delete.sql
-- Deleting a tenant cascades to its channel rows, but its Vault secrets ('<slug>/tg_bot_token', …) outlived it:
-- a dead tenant's bot token stayed readable by anyone with Vault access (I5). Found by the P3.D2.1 integration test.
create function private.tenants_drop_secrets() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  delete from vault.secrets where name like old.slug || '/%';
  return old;
end
$$;

create trigger tenants_drop_secrets
  after delete on public.tenants
  for each row execute function private.tenants_drop_secrets();

revoke execute on function private.tenants_drop_secrets() from public, anon, authenticated;

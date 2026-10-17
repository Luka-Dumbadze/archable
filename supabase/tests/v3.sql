-- supabase/tests/v3.sql: behavior of the v3 core schema on real Supabase (P1.D2.4). No stand-ins: real auth,
-- Vault, Realtime and pg_jsonschema. Self-contained fixtures inside one transaction that is always rolled back.
--
--   pnpm exec supabase db query --linked -f supabase/tests/v3.sql
--
-- Any failed assertion aborts with "FAIL: <group> <what>"; the last statement prints "v3.sql PASSED".
--   R1 RLS on every table        R2 planes see only their ctx tenant   R3 runtime grants
--   R4 member visibility         R5 records trigger                    R6 shell edit roles
--   R7 flip_epoch

begin;

-- The suite switches into the plane roles; the grant is undone by the rollback.
grant archable_runtime, archable_control to postgres with inherit false, set true;

create function pg_temp.ok(c boolean, label text) returns void language plpgsql as $$
begin
  if c is not true then raise exception 'FAIL: %', label; end if;
end $$;

-- Runs q as the current role and expects SQLSTATE state.
create function pg_temp.raises(q text, state text, label text) returns void language plpgsql as $$
begin
  begin
    execute q;
  exception when others then
    if sqlstate = state then return; end if;
    raise exception 'FAIL: % (expected %, got %: %)', label, state, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL: % (expected %, no error)', label, state;
end $$;

create function pg_temp.member(uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
$$;

grant execute on all functions in schema pg_temp to public;

-- ───────────────────────────── fixtures (as postgres) ─────────────────────────────
-- Tenant A (zz-alpha): owner, staff, developer. Tenant B (zz-beta): owner.

insert into public.tenants (id, slug, name, os_name, status) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'zz-alpha', 'Alpha', 'Alpha OS', 'live'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'zz-beta', 'Beta', 'Beta OS', 'live');

insert into auth.users (id, aud, role, email) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'owner-a@archable.test'),
  ('aaaaaaaa-0000-4000-8000-0000000000a2', 'authenticated', 'authenticated', 'staff-a@archable.test'),
  ('aaaaaaaa-0000-4000-8000-0000000000a3', 'authenticated', 'authenticated', 'dev-a@archable.test'),
  ('bbbbbbbb-0000-4000-8000-0000000000b1', 'authenticated', 'authenticated', 'owner-b@archable.test');

insert into public.memberships (id, tenant_id, role, display_name, user_id, tg_user_id) values
  ('aaaaaaaa-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-000000000001', 'owner', 'Owner A', 'aaaaaaaa-0000-4000-8000-0000000000a1', 1001),
  ('aaaaaaaa-0000-4000-8000-0000000000c2', 'aaaaaaaa-0000-4000-8000-000000000001', 'staff', 'Staff A', 'aaaaaaaa-0000-4000-8000-0000000000a2', 1002),
  ('aaaaaaaa-0000-4000-8000-0000000000c3', 'aaaaaaaa-0000-4000-8000-000000000001', 'developer', 'Dev A', 'aaaaaaaa-0000-4000-8000-0000000000a3', 1003),
  ('bbbbbbbb-0000-4000-8000-0000000000c1', 'bbbbbbbb-0000-4000-8000-000000000001', 'owner', 'Owner B', 'bbbbbbbb-0000-4000-8000-0000000000b1', 2001);

-- A: D1 verified (activated below), D2 candidate (never verified), D3 verified (flipped to in R7). B: DB verified.
insert into public.specs (tenant_id, digest, git_sha, compiler_version, bundle, state, verified_at) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'sha256:' || repeat('1', 64), 'sha-1', 'test', '{"secret":"prompt"}', 'candidate', now()),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'sha256:' || repeat('2', 64), 'sha-2', 'test', '{}', 'candidate', null),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'sha256:' || repeat('3', 64), 'sha-3', 'test', '{}', 'candidate', now()),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'sha256:' || repeat('b', 64), 'sha-b', 'test', '{}', 'candidate', now());

insert into public.entity_schemas (tenant_id, spec_digest, entity_type, json_schema, key_field, title_field, edit_roles, field_acl)
select t, d, e.entity_type, e.json_schema, e.key_field, e.title_field, e.edit_roles, e.field_acl
  from (values ('aaaaaaaa-0000-4000-8000-000000000001'::uuid, 'sha256:' || repeat('1', 64)),
               ('aaaaaaaa-0000-4000-8000-000000000001'::uuid, 'sha256:' || repeat('2', 64)),
               ('bbbbbbbb-0000-4000-8000-000000000001'::uuid, 'sha256:' || repeat('b', 64))) as s (t, d)
 cross join (values
   ('wine', '{"type":"object","additionalProperties":false,"required":["sku","label","price"],
              "properties":{"sku":{"type":"string"},"label":{"type":"string"},"price":{"type":"integer"}}}'::jsonb,
    'sku', 'label', '{owner,developer}'::text[], '{}'::jsonb),
   ('courier', '{"type":"object","additionalProperties":false,"required":["name"],
                 "properties":{"name":{"type":"string"},"payout_rate":{"type":"integer"}}}'::jsonb,
    'name', 'name', '{owner,developer,staff}'::text[], '{"payout_rate":["owner"]}'::jsonb)
 ) as e (entity_type, json_schema, key_field, title_field, edit_roles, field_acl);

select public.flip_epoch('aaaaaaaa-0000-4000-8000-000000000001', 0, 'sha256:' || repeat('1', 64));
select public.flip_epoch('bbbbbbbb-0000-4000-8000-000000000001', 0, 'sha256:' || repeat('b', 64));

insert into public.records (tenant_id, id, entity_type, attrs, spec_digest, created_by) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000d1', 'wine',
   '{"sku":"ALP-SAP-21","label":"Alpha Saperavi","price":3500}', 'sha256:' || repeat('1', 64), 'import'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-0000000000d1', 'wine',
   '{"sku":"BET-RKA-22","label":"Beta Rkatsiteli","price":2800}', 'sha256:' || repeat('b', 64), 'import');

insert into public.desires (tenant_id, source, statement) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'owner_request', 'Customers can pay cash on delivery up to 300 GEL');

-- ─────────────────────────────── R1 RLS on every table ───────────────────────────────

select pg_temp.ok(not exists (
  select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity), 'R1 every public table has RLS enabled');
select pg_temp.ok(not exists (
  select 1 from pg_tables t
   where t.schemaname = 'public'
     and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = t.tablename
                       and 'archable_runtime' = any (p.roles) and 'archable_control' = any (p.roles))),
  'R1 every public table has a plane policy');
select pg_temp.ok((select not rolbypassrls from pg_roles where rolname = 'archable_runtime')
              and (select not rolbypassrls from pg_roles where rolname = 'archable_control'), 'R1 neither plane bypasses RLS');

-- ─────────────────────────── R2 planes see only their ctx tenant ───────────────────────────

set local role archable_control;
select set_config('app.tenant_id', 'aaaaaaaa-0000-4000-8000-000000000001', true);
select pg_temp.ok((select array_agg(slug) from public.tenants) = '{zz-alpha}', 'R2 control sees only its tenant');
select pg_temp.ok((select count(*) from public.records) = 1, 'R2 control sees only its records');
select pg_temp.ok((select count(*) from public.memberships) = 3, 'R2 control sees only its memberships');
-- The records trigger runs before RLS's WITH CHECK and can't see B's bundle, so it refuses first (23514).
select pg_temp.raises($q$insert into public.records (tenant_id, entity_type, attrs, spec_digest, created_by)
  values ('bbbbbbbb-0000-4000-8000-000000000001', 'wine', '{"sku":"X-1","label":"x","price":1}', 'sha256:' || repeat('b', 64), 'import')$q$,
  '23514', 'R2 control cannot write another tenant''s record');
select pg_temp.raises($q$insert into public.failures (tenant_id, kind, severity, payload)
  values ('bbbbbbbb-0000-4000-8000-000000000001', 'tool_error', 1, '{}')$q$,
  '42501', 'R2 RLS WITH CHECK refuses another tenant''s row');
with u as (update public.records set display_name = 'x' where tenant_id = 'bbbbbbbb-0000-4000-8000-000000000001' returning 1)
select pg_temp.ok(count(*) = 0, 'R2 control cannot update another tenant''s record') from u;
select set_config('app.tenant_id', '', true);
select pg_temp.ok((select count(*) from public.tenants) = 0, 'R2 no ctx tenant: nothing visible');
reset role;

-- ─────────────────────────────── R3 runtime grants ───────────────────────────────

set local role archable_runtime;
select set_config('app.tenant_id', 'aaaaaaaa-0000-4000-8000-000000000001', true);
select pg_temp.ok((select count(*) from public.records) = 1, 'R3 runtime reads its records');
select pg_temp.raises($q$insert into public.specs (tenant_id, digest, git_sha, compiler_version, bundle)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'sha256:' || repeat('9', 64), 'x', 'x', '{}')$q$, '42501', 'R3 runtime cannot register bundles');
select pg_temp.raises($q$delete from public.records$q$, '42501', 'R3 runtime cannot delete records');
select pg_temp.raises($q$update public.tenants set name = 'x'$q$, '42501', 'R3 runtime cannot update tenants');
insert into public.decision_log (tenant_id, turn_id, head, stage, model, input_digest, answer, verdict, latency_ms)
values ('aaaaaaaa-0000-4000-8000-000000000001', gen_random_uuid(), 'send.grounded', 'pre_send', 'rule', 'sha256:x', '{}', 'pass', 3);
select pg_temp.raises($q$insert into public.decision_log (tenant_id, turn_id, head, stage, model, input_digest, answer, verdict, latency_ms)
  values ('bbbbbbbb-0000-4000-8000-000000000001', gen_random_uuid(), 'x', 'route', 'rule', 'x', '{}', 'x', 1)$q$,
  '42501', 'R3 runtime cannot log for another tenant');
reset role;

-- ─────────────────────────────── R4 member visibility ───────────────────────────────

set local role authenticated;
select pg_temp.member('aaaaaaaa-0000-4000-8000-0000000000a1');                     -- owner A
select pg_temp.ok((select array_agg(slug) from public.tenants) = '{zz-alpha}', 'R4 owner sees only their tenant');
select pg_temp.ok((select count(*) from public.records) = 1, 'R4 owner sees only their records');
select pg_temp.ok((select count(*) from public.specs where tenant_id = 'aaaaaaaa-0000-4000-8000-000000000001') = 3, 'R4 owner sees bundle metadata');
select pg_temp.raises($q$select bundle from public.specs$q$, '42501', 'R4 members cannot read bundles (prompts, policies)');
select pg_temp.ok((select count(*) from public.desires) = 1, 'R4 owner sees desires');
select pg_temp.raises($q$insert into public.specs (tenant_id, digest, git_sha, compiler_version, bundle)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'sha256:' || repeat('8', 64), 'x', 'x', '{}')$q$, '42501', 'R4 members cannot register bundles');
select pg_temp.raises($q$select * from private.step_up_devices$q$, '42501', 'R4 members cannot read step-up devices');
select pg_temp.member('aaaaaaaa-0000-4000-8000-0000000000a2');                     -- staff A
select pg_temp.ok((select count(*) from public.desires) = 0, 'R4 staff see no desires');
select pg_temp.ok((select count(*) from public.tenants) = 1, 'R4 staff see their tenant');
select pg_temp.member('bbbbbbbb-0000-4000-8000-0000000000b1');                     -- owner B
select pg_temp.ok((select count(*) from public.records where tenant_id = 'aaaaaaaa-0000-4000-8000-000000000001') = 0, 'R4 another tenant''s owner sees nothing of A');
reset role;
set local role anon;
select pg_temp.raises($q$select * from public.tenants$q$, '42501', 'R4 anon cannot read tenants');
reset role;

-- ─────────────────────────────── R5 records trigger ───────────────────────────────

set local role archable_control;
select set_config('app.tenant_id', 'aaaaaaaa-0000-4000-8000-000000000001', true);
select pg_temp.ok((select natural_key = 'ALP-SAP-21' and display_name = 'Alpha Saperavi' and search is not null and version = 1
                     from public.records where id = 'aaaaaaaa-0000-4000-8000-0000000000d1'), 'R5 natural key, title and search set');
select pg_temp.raises($q$insert into public.records (tenant_id, entity_type, attrs, spec_digest, created_by)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'wine', '{"sku":"ALP-1","label":"x","price":"12.00"}', 'sha256:' || repeat('1', 64), 'import')$q$,
  '23514', 'R5 attrs must match the schema (money is an integer)');
select pg_temp.raises($q$insert into public.records (tenant_id, entity_type, attrs, spec_digest, created_by)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'unicorn', '{}', 'sha256:' || repeat('1', 64), 'import')$q$,
  '23514', 'R5 unknown object rejected');
select pg_temp.raises($q$insert into public.records (tenant_id, entity_type, attrs, spec_digest, created_by)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'wine', '{"sku":"ALP-2","label":"x","price":1}', 'sha256:' || repeat('2', 64), 'import')$q$,
  '23514', 'R5 production writes need the active bundle');
insert into public.records (tenant_id, env, entity_type, attrs, spec_digest, created_by)
values ('aaaaaaaa-0000-4000-8000-000000000001', 'pr-7', 'wine', '{"sku":"ALP-3","label":"preview","price":1}', 'sha256:' || repeat('2', 64), 'architect');
select pg_temp.raises($q$insert into public.records (tenant_id, entity_type, attrs, spec_digest, created_by)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'wine', '{"sku":"ALP-SAP-21","label":"dup","price":1}', 'sha256:' || repeat('1', 64), 'import')$q$,
  '23505', 'R5 natural key is unique per tenant and env');
update public.records set attrs = attrs || '{"price":3600}' where id = 'aaaaaaaa-0000-4000-8000-0000000000d1';
select pg_temp.ok((select version = 2 and (attrs ->> 'price')::int = 3600 from public.records where id = 'aaaaaaaa-0000-4000-8000-0000000000d1'),
  'R5 update bumps the version');
reset role;

-- ─────────────────────────────── R6 shell edit roles ───────────────────────────────

set local role authenticated;
select pg_temp.member('aaaaaaaa-0000-4000-8000-0000000000a2');                     -- staff A
select pg_temp.raises($q$insert into public.records (tenant_id, entity_type, attrs, spec_digest, created_by)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'wine', '{"sku":"ALP-4","label":"x","price":1}', 'sha256:' || repeat('1', 64), 'user:staff')$q$,
  '42501', 'R6 staff cannot edit an owner-only object');
select pg_temp.raises($q$insert into public.records (tenant_id, entity_type, attrs, spec_digest, created_by)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'courier', '{"name":"Gio","payout_rate":500}', 'sha256:' || repeat('1', 64), 'user:staff')$q$,
  '42501', 'R6 staff cannot set an owner-only field');
insert into public.records (tenant_id, id, entity_type, attrs, spec_digest, created_by)
values ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000d2', 'courier', '{"name":"Gio"}', 'sha256:' || repeat('1', 64), 'user:staff');
update public.records set attrs = '{"name":"Giorgi"}' where id = 'aaaaaaaa-0000-4000-8000-0000000000d2';
select pg_temp.raises($q$update public.records set attrs = '{"name":"Giorgi","payout_rate":900}' where id = 'aaaaaaaa-0000-4000-8000-0000000000d2'$q$,
  '42501', 'R6 staff cannot change an owner-only field');
select pg_temp.member('aaaaaaaa-0000-4000-8000-0000000000a1');                     -- owner A
update public.records set attrs = '{"name":"Giorgi","payout_rate":700}' where id = 'aaaaaaaa-0000-4000-8000-0000000000d2';
select pg_temp.member('bbbbbbbb-0000-4000-8000-0000000000b1');                     -- owner B
select pg_temp.raises($q$insert into public.records (tenant_id, entity_type, attrs, spec_digest, created_by)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'courier', '{"name":"x"}', 'sha256:' || repeat('1', 64), 'user:b')$q$,
  '23514', 'R6 a member of B cannot write into A (A''s bundle is invisible to them)');
reset role;
select pg_temp.ok((select display_name = 'Giorgi' and (attrs ->> 'payout_rate')::int = 700 and version = 3
                     from public.records where id = 'aaaaaaaa-0000-4000-8000-0000000000d2'), 'R6 staff renamed, owner set the rate');

-- ─────────────────────────────────── R7 flip_epoch ───────────────────────────────────

set local role archable_control;
select set_config('app.tenant_id', 'aaaaaaaa-0000-4000-8000-000000000001', true);
select pg_temp.raises($q$select public.flip_epoch('aaaaaaaa-0000-4000-8000-000000000001', 1, 'sha256:' || repeat('2', 64))$q$,
  '23514', 'R7 an unverified bundle cannot go live');
select pg_temp.raises($q$select public.flip_epoch('aaaaaaaa-0000-4000-8000-000000000001', 0, 'sha256:' || repeat('3', 64))$q$,
  '40001', 'R7 a stale expected epoch is refused');
select pg_temp.raises($q$select public.flip_epoch('cccccccc-0000-4000-8000-000000000001', 0, 'sha256:' || repeat('3', 64))$q$,
  'P0002', 'R7 unknown tenant');
select pg_temp.ok(public.flip_epoch('aaaaaaaa-0000-4000-8000-000000000001', 1, 'sha256:' || repeat('3', 64)) = 2, 'R7 flip returns the new epoch');
reset role;
select pg_temp.ok((select epoch = 2 and active_digest = 'sha256:' || repeat('3', 64) from public.tenants where slug = 'zz-alpha'), 'R7 pointer moved');
select pg_temp.ok((select state = 'draining' and drain_until > now() from public.specs where digest = 'sha256:' || repeat('1', 64)), 'R7 previous bundle drains');
select pg_temp.ok((select array_agg(digest) from public.specs where tenant_id = 'aaaaaaaa-0000-4000-8000-000000000001' and state = 'active')
                  = array['sha256:' || repeat('3', 64)], 'R7 exactly one active bundle');
set local role archable_runtime;
select pg_temp.raises($q$select public.flip_epoch('aaaaaaaa-0000-4000-8000-000000000001', 2, 'sha256:' || repeat('1', 64))$q$,
  '42501', 'R7 runtime cannot flip');
reset role;
set local role authenticated;
select pg_temp.member('aaaaaaaa-0000-4000-8000-0000000000a1');
select pg_temp.raises($q$select public.flip_epoch('aaaaaaaa-0000-4000-8000-000000000001', 2, 'sha256:' || repeat('1', 64))$q$,
  '42501', 'R7 members cannot flip');
reset role;

rollback;
select 'v3.sql PASSED (R1–R7)' as result;

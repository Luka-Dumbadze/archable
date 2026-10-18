-- supabase/tests/v3_1.sql: behavior of the v3.1 delta on real Supabase (P1.D2.4), the groups of plan §9.3.
-- No stand-ins: real Vault, Realtime, auth and pg_jsonschema. One transaction, always rolled back.
--
--   pnpm exec supabase db query --linked -f supabase/tests/v3_1.sql
--
-- Any failed assertion aborts with "FAIL: <group> <what>"; the last statement prints "v3_1.sql PASSED".
--   D1 step-up/confirm_mode coupling   D2 tenant bot     D3 Business         D4 web sessions
--   D5 member visibility               D6 rationale      D7 typed confirm    D8 live graph
--   D9 takeover, reserved slugs
-- D1's backfill (step_up rows → 'biometric') ran once when the migration was applied and can't be replayed here;
-- the suite asserts the invariant it left behind.

begin;

grant archable_runtime, archable_control to postgres with inherit false, set true;   -- undone by the rollback

create function pg_temp.ok(c boolean, label text) returns void language plpgsql as $$
begin
  if c is not true then raise exception 'FAIL: %', label; end if;
end $$;

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

create function pg_temp.h(s text) returns bytea language sql immutable as $$ select sha256(convert_to(s, 'UTF8')) $$;

grant execute on all functions in schema pg_temp to public;

-- ───────────────────────────── fixtures (as postgres) ─────────────────────────────

insert into public.tenants (id, slug, name, os_name, status) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'zz-alpha', 'Alpha', 'Alpha OS', 'live'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'zz-beta', 'Beta', 'Beta OS', 'live');

insert into auth.users (id, aud, role, email) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'owner-a@archable.test'),
  ('aaaaaaaa-0000-4000-8000-0000000000a2', 'authenticated', 'authenticated', 'staff-a@archable.test'),
  ('bbbbbbbb-0000-4000-8000-0000000000b1', 'authenticated', 'authenticated', 'owner-b@archable.test');

insert into public.memberships (id, tenant_id, role, display_name, user_id, tg_user_id) values
  ('aaaaaaaa-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-000000000001', 'owner', 'Owner A', 'aaaaaaaa-0000-4000-8000-0000000000a1', 1001),
  ('aaaaaaaa-0000-4000-8000-0000000000c2', 'aaaaaaaa-0000-4000-8000-000000000001', 'staff', 'Staff A', 'aaaaaaaa-0000-4000-8000-0000000000a2', 1002),
  ('bbbbbbbb-0000-4000-8000-0000000000c1', 'bbbbbbbb-0000-4000-8000-000000000001', 'owner', 'Owner B', 'bbbbbbbb-0000-4000-8000-0000000000b1', 2001);

insert into public.specs (tenant_id, digest, git_sha, compiler_version, bundle, verified_at) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'sha256:' || repeat('1', 64), 'sha-1', 'test', '{}', now()),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'sha256:' || repeat('b', 64), 'sha-b', 'test', '{}', now());
insert into public.entity_schemas (tenant_id, spec_digest, entity_type, json_schema, key_field, title_field) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'sha256:' || repeat('1', 64), 'customer', '{"type":"object"}', 'phone', 'name'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'sha256:' || repeat('1', 64), 'order', '{"type":"object"}', 'number', 'number');
select public.flip_epoch('aaaaaaaa-0000-4000-8000-000000000001', 0, 'sha256:' || repeat('1', 64));
select public.flip_epoch('bbbbbbbb-0000-4000-8000-000000000001', 0, 'sha256:' || repeat('b', 64));

insert into public.records (tenant_id, id, entity_type, attrs, spec_digest, created_by) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000e1', 'customer', '{"phone":"+995555000111","name":"Nino"}', 'sha256:' || repeat('1', 64), 'import'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000e2', 'customer', '{"phone":"+995555000222","name":"Levan"}', 'sha256:' || repeat('1', 64), 'import'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000e3', 'order', '{"number":"M-00001"}', 'sha256:' || repeat('1', 64), 'agent:cellar_master');

-- Change requests behind the approvals of D1 and D7.
insert into public.change_requests (tenant_id, id, pr_number, title, author_kind, base_sha, head_sha)
select 'aaaaaaaa-0000-4000-8000-000000000001', ('aaaaaaaa-0000-4000-8000-00000000f00' || n)::uuid, 50 + n, 'D-14 change ' || n,
       'architect', 'base', 'head-' || n
  from generate_series(0, 9) n;

-- ─────────────────────────── D1 step-up and confirm_mode ───────────────────────────

select pg_temp.ok(not exists (select 1 from public.approvals where step_up and confirm_mode = 'tap'),
  'D1 no step-up approval is left in tap mode (backfill invariant)');
select pg_temp.raises($q$insert into public.approvals (tenant_id, change_request_id, role, approver, channel, head_sha, delta_digest,
    summary_digest, tier, step_up, expires_at)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000f009', 'owner', 'aaaaaaaa-0000-4000-8000-0000000000c1',
          'telegram_button', 'h', 'd', 's', 3, true, now() + interval '1 hour')$q$,
  '23514', 'D1 a step-up approval must name a non-tap confirm mode');
select pg_temp.raises($q$insert into public.approvals (tenant_id, change_request_id, role, approver, channel, head_sha, delta_digest,
    summary_digest, tier, step_up, confirm_mode, expires_at)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000f009', 'owner', 'aaaaaaaa-0000-4000-8000-0000000000c1',
          'telegram_button', 'h', 'd', 's', 1, false, 'typed', now() + interval '1 hour')$q$,
  '23514', 'D1 typed confirmation implies step-up');
select pg_temp.raises($q$insert into public.approvals (tenant_id, change_request_id, role, approver, channel, head_sha, delta_digest,
    summary_digest, tier, expires_at)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000f009', 'owner', 'aaaaaaaa-0000-4000-8000-0000000000c1',
          'sms', 'h', 'd', 's', 1, now() + interval '1 hour')$q$,
  '23514', 'D1 unknown approval channel rejected');

-- ─────────────────────────────────── D2 tenant bot ───────────────────────────────────

set local role archable_control;
select set_config('app.tenant_id', 'aaaaaaaa-0000-4000-8000-000000000001', true);
select pg_temp.raises($q$select public.bind_tenant_bot('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000c2',
    555, 'alpha_bot', 'TOKEN-1', 'aaaaaaaa-0000-4000-8000-0000000001a1', pg_temp.h('s1'))$q$, '42501', 'D2 staff cannot bind a bot');
select pg_temp.raises($q$select public.bind_tenant_bot('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-0000000000c1',
    555, 'alpha_bot', 'TOKEN-1', 'aaaaaaaa-0000-4000-8000-0000000001a1', pg_temp.h('s1'))$q$, '42501', 'D2 another tenant''s owner cannot bind');
select set_config('t.ch1', public.bind_tenant_bot('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000c1',
    555, 'alpha_bot', 'TOKEN-1', 'aaaaaaaa-0000-4000-8000-0000000001a1', pg_temp.h('s1'))::text, true);
select pg_temp.ok(private.channel_secret('zz-alpha/tg_bot_token') = 'TOKEN-1', 'D2 the token is readable at the tenant''s last hop');
select pg_temp.ok(private.channel_secret('zz-beta/tg_bot_token') is null, 'D2 a plane cannot read another tenant''s secret name');
reset role;
select pg_temp.ok((select count(*) from vault.decrypted_secrets where name = 'zz-alpha/tg_bot_token' and decrypted_secret = 'TOKEN-1') = 1,
  'D2 the token lands in Vault');
select pg_temp.ok((select token_secret = 'zz-alpha/tg_bot_token' from public.channel_connections where id = current_setting('t.ch1')::uuid),
  'D2 the row stores the Vault name, not the token');
set local role archable_runtime;
select set_config('app.tenant_id', 'aaaaaaaa-0000-4000-8000-000000000001', true);
select pg_temp.ok(private.channel_secret('zz-alpha/tg_bot_token') = 'TOKEN-1', 'D2 runtime reads the token for its tenant');
select pg_temp.ok((select count(*) from private.resolve_bot_hook('aaaaaaaa-0000-4000-8000-0000000001a1')) = 1, 'D2 the hook resolves');
select set_config('app.tenant_id', 'bbbbbbbb-0000-4000-8000-000000000001', true);
select pg_temp.ok(private.channel_secret('zz-alpha/tg_bot_token') is null, 'D2 another tenant''s plane cannot read it');
select pg_temp.ok((select count(*) from public.channel_connections) = 0, 'D2 another tenant sees no channel rows');
select pg_temp.raises($q$select public.bind_tenant_bot('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000c1',
    556, 'x', 'x', 'aaaaaaaa-0000-4000-8000-0000000001a9', pg_temp.h('x'))$q$, '42501', 'D2 the runtime role cannot bind');
reset role;
set local role archable_control;
select set_config('app.tenant_id', 'aaaaaaaa-0000-4000-8000-000000000001', true);
select set_config('t.ch2', public.bind_tenant_bot('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000c1',
    556, 'alpha_bot2', 'TOKEN-2', 'aaaaaaaa-0000-4000-8000-0000000001a2', pg_temp.h('s2'))::text, true);
select pg_temp.ok((select status from public.channel_connections where id = current_setting('t.ch1')::uuid) = 'revoked', 'D2 rebinding revokes the old bot');
select pg_temp.ok(private.channel_secret('zz-alpha/tg_bot_token') = 'TOKEN-2', 'D2 the old token is gone from Vault');
select pg_temp.raises($q$select * from private.resolve_bot_hook('aaaaaaaa-0000-4000-8000-0000000001a2')$q$, '42501', 'D2 only the runtime resolves hooks');
reset role;
set local role archable_runtime;                                                      -- webhook ingress: no tenant known yet
select pg_temp.ok((select count(*) from private.resolve_bot_hook('aaaaaaaa-0000-4000-8000-0000000001a1')) = 0, 'D2 the old hook resolves nothing');
select pg_temp.ok((select bot_id = 556 from private.resolve_bot_hook('aaaaaaaa-0000-4000-8000-0000000001a2')), 'D2 the new hook resolves');
reset role;

-- ─────────────────────────────────── D3 Business ───────────────────────────────────
-- @ArchableBot is bot 9000; the owner of A is Telegram user 1001, staff 1002.

set local role archable_control;
select set_config('app.tenant_id', 'aaaaaaaa-0000-4000-8000-000000000001', true);
select pg_temp.ok((select outcome from public.bind_business_connection(9000, 'bc-1', 1001, 1001, false, true)) = 'no_intent', 'D3 no intent');
reset role;
insert into public.channel_link_intents (tenant_id, membership_id, tg_user_id)
values ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000c1', 1002);
insert into public.channel_link_intents (tenant_id, membership_id, tg_user_id, expires_at)
values ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000c1', 1001, now() - interval '1 minute');
set local role archable_control;
select pg_temp.ok((select outcome from public.bind_business_connection(9000, 'bc-1', 1002, 1002, false, true)) = 'not_owner',
  'D3 an intent for another person''s membership: not_owner');
select pg_temp.ok((select outcome from public.bind_business_connection(9000, 'bc-1', 1001, 1001, false, true)) = 'no_intent',
  'D3 an expired intent is ignored');
reset role;
insert into public.channel_link_intents (tenant_id, membership_id, tg_user_id)
values ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000c1', 1001);
set local role archable_control;
select pg_temp.ok((select outcome = 'bound' and tenant_id = 'aaaaaaaa-0000-4000-8000-000000000001'
                     from public.bind_business_connection(9000, 'bc-1', 1001, 1001, false, true)), 'D3 bound');
select pg_temp.ok((select not can_reply from private.resolve_business_connection(9000, 'bc-1')), 'D3 bound in suggest mode');
select pg_temp.ok((select outcome from public.bind_business_connection(9000, 'bc-1', 1001, 1001, true, true)) = 'updated', 'D3 rights edited');
select pg_temp.ok((select can_reply from private.resolve_business_connection(9000, 'bc-1')), 'D3 now replies');
select pg_temp.ok((select count(*) from private.resolve_business_connection(9001, 'bc-1')) = 0, 'D3 wrong bot id resolves nothing');
select pg_temp.ok((select outcome from public.bind_business_connection(9000, 'bc-1', 1001, 1001, true, false)) = 'disconnected', 'D3 disconnect');
select pg_temp.ok((select count(*) from private.resolve_business_connection(9000, 'bc-1')) = 0, 'D3 disconnect stops resolution');
reset role;
select pg_temp.ok((select consumed_at is not null from public.channel_link_intents where tg_user_id = 1001 and expires_at > now()),
  'D3 the intent was consumed');

-- ─────────────────────────────────── D4 web sessions ───────────────────────────────────

set local role archable_runtime;
select pg_temp.ok((select count(*) from public.open_web_session('zz-alpha', 'prod', pg_temp.h('w1'), 'https://alpha.example')) = 0,
  'D4 chat off returns nothing');
reset role;
insert into public.channel_connections (tenant_id, channel_key, kind) values ('aaaaaaaa-0000-4000-8000-000000000001', 'web_chat', 'web');
set local role archable_runtime;
select set_config('t.sid', (select session_id::text from public.open_web_session('zz-alpha', 'prod', pg_temp.h('w1'), 'https://alpha.example')), true);
select pg_temp.ok(current_setting('t.sid') <> '', 'D4 open');
select pg_temp.ok((select session_id::text from public.resume_web_session(pg_temp.h('w1'))) = current_setting('t.sid'),
  'D4 resume by secret hash returns the same session');
select pg_temp.ok((select count(*) from public.resume_web_session(pg_temp.h('nope'))) = 0, 'D4 an unknown secret resumes nothing');
select pg_temp.raises($q$select * from public.open_web_session('zz-alpha', 'staging', pg_temp.h('w2'), null)$q$, '22023', 'D4 bad env rejected');
select pg_temp.ok((select count(*) from public.open_web_session('zz-nobody', 'prod', pg_temp.h('w3'), null)) = 0, 'D4 unknown tenant');
reset role;
select pg_temp.ok((select c.channel = 'web' and c.external_id = 'ws_' || s.id
                     from public.web_sessions s join public.conversations c on c.tenant_id = s.tenant_id and c.id = s.conversation_id
                    where s.id = current_setting('t.sid')::uuid), 'D4 conversation keyed by the public id');
set local role anon;
select pg_temp.raises($q$select * from public.open_web_session('zz-alpha', 'prod', pg_temp.h('w4'), null)$q$, '42501', 'D4 anon cannot call');
select pg_temp.raises($q$select * from public.web_sessions$q$, '42501', 'D4 anon cannot read sessions');
reset role;

-- ───────────────────────────────── D5 member visibility ─────────────────────────────────

set local role authenticated;
select pg_temp.member('aaaaaaaa-0000-4000-8000-0000000000a2');                     -- staff A
select pg_temp.ok((select count(*) from (select id from public.channel_connections) x) = 0, 'D5 staff see no channel rows');
select pg_temp.member('aaaaaaaa-0000-4000-8000-0000000000a1');                     -- owner A
select pg_temp.ok((select count(*) from (select tenant_id, id, channel_key, kind, status, bot_username, can_reply, created_at
                                           from public.channel_connections) x) >= 3, 'D5 the owner sees the safe columns');
select pg_temp.raises($q$select hook_secret_hash from public.channel_connections$q$, '42501', 'D5 the owner never sees hook_secret_hash');
select pg_temp.raises($q$select token_secret from public.channel_connections$q$, '42501', 'D5 the owner never sees the Vault name');
select pg_temp.raises($q$select * from public.desire_impact('aaaaaaaa-0000-4000-8000-000000000001', gen_random_uuid())$q$,
  '42501', 'D5 desire_impact is not callable by members');
select pg_temp.member('bbbbbbbb-0000-4000-8000-0000000000b1');                     -- owner B
select pg_temp.ok((select count(*) from (select id from public.channel_connections) x) = 0, 'D5 another tenant''s owner sees none of A''s channels');
reset role;

-- ─────────────────────────────── D6 rationale arithmetic ───────────────────────────────
-- Six chapters: ordered; quoted inside the 2 h quiet window; unpriced; unlinked by the owner;
-- abandoned at 60 GEL; abandoned at 80 GEL. Expected: 5 chats, 2 customers, 4 quoted, 2 abandoned, 14000 tetri, 1 ordered.

insert into public.desires (tenant_id, id, source, statement)
values ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000d6', 'failure_cluster', 'Cash on delivery');
insert into public.chapters (tenant_id, id, customer_id, kind, last_quote_total, last_quote_at, order_id, opened_at) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000006001', 'aaaaaaaa-0000-4000-8000-0000000000e1', 'order_new', 5000, now() - interval '3 hours', 'aaaaaaaa-0000-4000-8000-0000000000e3', now() - interval '4 hours'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000006002', 'aaaaaaaa-0000-4000-8000-0000000000e1', 'order_new', 9000, now() - interval '30 minutes', null, now() - interval '1 hour'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000006003', 'aaaaaaaa-0000-4000-8000-0000000000e2', 'catalog', null, null, null, now() - interval '5 hours'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000006004', 'aaaaaaaa-0000-4000-8000-0000000000e2', 'order_new', 99999, now() - interval '5 hours', null, now() - interval '6 hours'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000006005', 'aaaaaaaa-0000-4000-8000-0000000000e2', 'order_new', 6000, now() - interval '3 hours', null, now() - interval '4 hours'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000006006', 'aaaaaaaa-0000-4000-8000-0000000000e1', 'order_new', 8000, now() - interval '4 hours', null, now() - interval '5 hours');
insert into public.desire_chapters (tenant_id, desire_id, chapter_id, linked_by, p, unlinked_at)
select 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000d6', ('aaaaaaaa-0000-4000-8000-00000000600' || n)::uuid,
       'jev:desire.dedupe', 0.9, case when n = 4 then now() end
  from generate_series(1, 6) n;
set local role archable_control;
select set_config('app.tenant_id', 'aaaaaaaa-0000-4000-8000-000000000001', true);
select pg_temp.ok((select chapters = 5 and customers = 2 and quoted = 4 and abandoned = 2 and abandoned_value = 14000 and ordered = 1
                     from public.desire_impact('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000d6')),
  'D6 5 chats, 2 customers, 4 quoted, 2 abandoned, 14000 tetri, 1 ordered');
reset role;

-- ─────────────────────────────── D7 typed confirmation ───────────────────────────────
-- One T3 typed approval per change request (f000…f004); the owner's chat is 1001.

insert into public.approvals (tenant_id, change_request_id, role, approver, channel, nonce_hash, tg_chat_id, tg_message_id,
                              head_sha, delta_digest, summary_digest, tier, step_up, confirm_mode, status, decided_at, expires_at)
select 'aaaaaaaa-0000-4000-8000-000000000001', ('aaaaaaaa-0000-4000-8000-00000000f00' || n)::uuid, 'owner', 'aaaaaaaa-0000-4000-8000-0000000000c1',
       'telegram_button', pg_temp.h('n' || n), 1001, 54 + n, 'head-' || n, 'delta', 'summary', 3, true, 'typed',
       case when n = 0 then 'approved' else 'pending' end, case when n = 0 then now() end, now() + interval '1 hour'
  from generate_series(0, 4) n;

set local role archable_control;
select set_config('app.tenant_id', 'aaaaaaaa-0000-4000-8000-000000000001', true);
select pg_temp.ok((select outcome from public.consume_telegram_approval(pg_temp.h('n1'), 1001, 1001, 55, 'approve', '{}')) = 'step_up_required',
  'D7 the button alone cannot approve T3');
select pg_temp.ok((select outcome from public.complete_typed_confirmation(1001, 1001, pg_temp.h('4821'), '{}')) = 'no_challenge', 'D7 no challenge');
select pg_temp.ok((select outcome from public.begin_typed_confirmation(pg_temp.h('n1'), 1002, 1001, 55, pg_temp.h('4821'))) = 'wrong_person', 'D7 wrong person');
select pg_temp.ok((select outcome from public.begin_typed_confirmation(pg_temp.h('n1'), 1001, 1001, 56, pg_temp.h('4821'))) = 'wrong_message', 'D7 wrong message');
select pg_temp.ok((select outcome from public.begin_typed_confirmation(pg_temp.h('n0'), 1001, 1001, 54, pg_temp.h('4821'))) = 'approved', 'D7 decided approval');
select pg_temp.ok((select outcome from public.begin_typed_confirmation(pg_temp.h('n1'), 1001, 1001, 55, pg_temp.h('4821'))) = 'challenge_open', 'D7 open');
select pg_temp.ok((select outcome from public.complete_typed_confirmation(1001, 9999, pg_temp.h('4821'), '{}')) = 'wrong_chat', 'D7 wrong chat');
select pg_temp.ok((select outcome from public.complete_typed_confirmation(1001, 1001, pg_temp.h('0000'), '{}')) = 'wrong_code', 'D7 wrong code');
select pg_temp.ok((select outcome from public.complete_typed_confirmation(1002, 1001, pg_temp.h('4821'), '{}')) = 'no_challenge', 'D7 other person');
select pg_temp.ok((select outcome = 'approved' and head_sha = 'head-1'
                     from public.complete_typed_confirmation(1001, 1001, pg_temp.h('4821'), '{"update_id":1}')), 'D7 approve');
select pg_temp.ok((select outcome from public.complete_typed_confirmation(1001, 1001, pg_temp.h('4821'), '{}')) = 'no_challenge', 'D7 single use');
reset role;
select pg_temp.ok((select status = 'approved' and channel = 'telegram_typed' and decided_at is not null and evidence = '{"update_id":1}'
                     from public.approvals where nonce_hash = pg_temp.h('n1')), 'D7 channel recorded');

set local role archable_control;
select pg_temp.ok((select outcome from public.begin_typed_confirmation(pg_temp.h('n2'), 1001, 1001, 56, pg_temp.h('1111'))) = 'challenge_open', 'D7 burn: open');
select pg_temp.ok((select outcome from public.complete_typed_confirmation(1001, 1001, pg_temp.h('0001'), '{}')) = 'wrong_code', 'D7 burn: wrong code 1');
select pg_temp.ok((select outcome from public.complete_typed_confirmation(1001, 1001, pg_temp.h('0002'), '{}')) = 'wrong_code', 'D7 burn: wrong code 2');
select pg_temp.ok((select outcome from public.complete_typed_confirmation(1001, 1001, pg_temp.h('0003'), '{}')) = 'wrong_code', 'D7 burn: wrong code 3');
select pg_temp.ok((select outcome from public.complete_typed_confirmation(1001, 1001, pg_temp.h('0004'), '{}')) = 'wrong_code', 'D7 burn: wrong code 4');
select pg_temp.ok((select outcome from public.complete_typed_confirmation(1001, 1001, pg_temp.h('0005'), '{}')) = 'wrong_code', 'D7 burn: wrong code 5');
select pg_temp.ok((select outcome from public.complete_typed_confirmation(1001, 1001, pg_temp.h('1111'), '{}')) = 'no_challenge', 'D7 5 wrong codes burn it');
reset role;
select pg_temp.ok((select status = 'pending' from public.approvals where nonce_hash = pg_temp.h('n2')), 'D7 a burnt challenge leaves the approval pending');

set local role archable_control;
select pg_temp.ok((select outcome from public.begin_typed_confirmation(pg_temp.h('n3'), 1001, 1001, 57, pg_temp.h('2222'))) = 'challenge_open', 'D7 first tap');
select pg_temp.ok((select outcome from public.begin_typed_confirmation(pg_temp.h('n3'), 1001, 1001, 57, pg_temp.h('3333'))) = 'challenge_open', 'D7 a new tap supersedes');
select pg_temp.ok((select outcome from public.complete_typed_confirmation(1001, 1001, pg_temp.h('2222'), '{}')) = 'wrong_code', 'D7 old code dead');
select pg_temp.ok((select outcome from public.complete_typed_confirmation(1001, 1001, pg_temp.h('3333'), '{}')) = 'approved', 'D7 new code works');
select pg_temp.ok((select outcome from public.begin_typed_confirmation(pg_temp.h('n4'), 1001, 1001, 58, pg_temp.h('4444'))) = 'challenge_open', 'D7 expiry: open');
reset role;
update private.approval_challenges set expires_at = now() - interval '1 second' where status = 'open' and tg_user_id = 1001;
set local role archable_control;
select pg_temp.ok((select outcome from public.complete_typed_confirmation(1001, 1001, pg_temp.h('4444'), '{}')) = 'challenge_expired', 'D7 expired challenge');
reset role;
select pg_temp.ok((select status = 'pending' from public.approvals where nonce_hash = pg_temp.h('n4')), 'D7 expiry leaves the approval pending');
set local role archable_runtime;
select pg_temp.raises($q$select * from public.begin_typed_confirmation(pg_temp.h('n4'), 1001, 1001, 58, pg_temp.h('4444'))$q$, '42501', 'D7 runtime cannot begin');
select pg_temp.raises($q$select * from public.complete_typed_confirmation(1001, 1001, pg_temp.h('4444'), '{}')$q$, '42501', 'D7 runtime cannot complete');
reset role;

-- ─────────────────────────────────── D8 live graph ───────────────────────────────────
-- realtime.send stores broadcasts in today's realtime.messages partition, which the Realtime service creates.
-- Without it the send only warns, so the suite then checks that the trigger is wired.

set local role archable_runtime;
select set_config('app.tenant_id', 'aaaaaaaa-0000-4000-8000-000000000001', true);
insert into public.tool_calls (tenant_id, turn_id, caller, tool, args_digest, decision, status, latency_ms)
values ('aaaaaaaa-0000-4000-8000-000000000001', gen_random_uuid(), 'agent:cellar_master', 'delivery.status', 'sha256:x', 'allow', 'ok', 12);
reset role;
select pg_temp.ok((select tgenabled = 'O' from pg_trigger where tgname = 'tool_calls_broadcast' and tgrelid = 'public.tool_calls'::regclass),
  'D8 tool_calls_broadcast trigger is enabled');
select pg_temp.ok(
  case when exists (select 1 from pg_inherits i join pg_class c on c.oid = i.inhrelid
                     where i.inhparent = 'realtime.messages'::regclass
                       and c.relname = 'messages_' || to_char(now() at time zone 'utc', 'YYYY_MM_DD'))
       then exists (select 1 from realtime.messages m
                     where m.topic = 'tenant:aaaaaaaa-0000-4000-8000-000000000001' and m.event = 'tool_call' and m.private)
       else true end,
  'D8 a tool_calls insert broadcasts on tenant:<id>');

-- ─────────────────────────────── D9 takeover, reserved slugs ───────────────────────────────

set local role archable_runtime;
select set_config('app.tenant_id', 'aaaaaaaa-0000-4000-8000-000000000001', true);
with u as (update public.conversations set agent_paused_until = now() + interval '1 hour'
            where id = (select conversation_id from public.web_sessions where id = current_setting('t.sid')::uuid) returning 1)
select pg_temp.ok(count(*) = 1, 'D9 runtime can pause a conversation') from u;
reset role;
select pg_temp.raises($q$insert into public.tenants (slug, name, os_name) values ('api', 'x', 'x')$q$, '23514', 'D9 api cannot be a tenant slug');
select pg_temp.raises($q$insert into public.tenants (slug, name, os_name) values ('zz--pr', 'x', 'x')$q$, '23514', 'D9 -- is reserved for previews');

-- ─────────────────── D2 (cont.) a deleted tenant takes its secrets with it ───────────────────
-- Migration 20261018000004: the cascade removes channel rows; the trigger removes '<slug>/…' Vault secrets.

insert into public.tenants (id, slug, name, os_name, status) values ('cccccccc-0000-4000-8000-000000000001', 'zz-gamma', 'Gamma', 'Gamma OS', 'live');
insert into public.memberships (id, tenant_id, role, display_name, tg_user_id)
values ('cccccccc-0000-4000-8000-0000000000c1', 'cccccccc-0000-4000-8000-000000000001', 'owner', 'Owner C', 3001);
select public.bind_tenant_bot('cccccccc-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-0000000000c1',
                              557, 'gamma_bot', 'TOKEN-C', 'cccccccc-0000-4000-8000-0000000001a1', pg_temp.h('sc'));
select pg_temp.ok((select count(*) from vault.secrets where name = 'zz-gamma/tg_bot_token') = 1, 'D2 the gamma token is in Vault');
delete from public.tenants where id = 'cccccccc-0000-4000-8000-000000000001';
select pg_temp.ok((select count(*) from vault.secrets where name like 'zz-gamma/%') = 0, 'D2 deleting a tenant deletes its Vault secrets');

rollback;
select 'v3_1.sql PASSED (D1–D9' ||
       case when exists (select 1 from pg_inherits i join pg_class c on c.oid = i.inhrelid
                          where i.inhparent = 'realtime.messages'::regclass
                            and c.relname = 'messages_' || to_char(now() at time zone 'utc', 'YYYY_MM_DD'))
            then ')' else '; D8 checked the trigger only: no realtime.messages partition for today yet)' end as result;

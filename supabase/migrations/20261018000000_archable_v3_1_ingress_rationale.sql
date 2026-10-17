-- supabase/migrations/20261018000000_archable_v3_1_ingress_rationale.sql
-- Additive to 20261017000000_archable_v3.sql. Channel bindings, web sessions, rationale grounding,
-- typed confirmation for T3/T4, and the index the A2A graph reads. Definitions stay in Git (I1):
-- widget copy, theme and embed origins are spec, not columns.

-- Platform hostnames can't be tenant slugs (api.archable.run must never resolve to a tenant).
alter table public.tenants add constraint tenants_slug_reserved
  check (slug not in ('api', 'www', 'app', 'admin', 'docs', 'status', 'mcp', 'widget', 'chat', 'auth', 'static', 'cdn'));

-- ─────────────────────────────── channel bindings ───────────────────────────────
-- The spec says a tenant HAS a channel (channels.tg_customers). Which bot or Business connection
-- serves it is a fact, bound by the owner at runtime, so it lives here. Tokens live in Vault only.

create table public.channel_connections (
  tenant_id              uuid not null references public.tenants (id) on delete cascade,
  id                     uuid not null default gen_random_uuid(),
  channel_key            text not null,                  -- spec key: 'tg_customers' | 'tg_business' | 'web_chat'
  kind                   text not null check (kind in ('telegram_bot', 'telegram_business', 'web')),
  status                 text not null default 'live' check (status in ('live', 'paused', 'revoked')),
  -- telegram_bot: a tenant bot created in BotFather
  bot_id                 bigint,                          -- the token's first segment; public
  bot_username           text,
  hook_id                uuid unique,                     -- webhook path segment: opaque, rotatable
  hook_secret_hash       bytea,                           -- sha256 of the X-Telegram-Bot-Api-Secret-Token value
  token_secret           text,                            -- Vault name '<slug>/tg_bot_token'
  -- telegram_business: the owner's own account, connected to @ArchableBot
  via_bot_id             bigint,
  business_connection_id text,
  business_user_id       bigint,                          -- the owner's Telegram user id
  business_user_chat_id  bigint,
  can_reply              boolean not null default false,  -- rights.can_reply; false = suggest-only mode
  connected_by           uuid references public.memberships (id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  primary key (tenant_id, id),
  check (case kind
           when 'telegram_bot' then bot_id is not null and hook_id is not null
                                    and hook_secret_hash is not null and token_secret is not null
           when 'telegram_business' then business_connection_id is not null and via_bot_id is not null
                                    and business_user_id is not null
           else true end)
);
create unique index channel_bot_once on public.channel_connections (bot_id)
  where kind = 'telegram_bot' and status <> 'revoked';
create unique index channel_business_once on public.channel_connections (business_connection_id)
  where kind = 'telegram_business' and status <> 'revoked';
create unique index channel_web_once on public.channel_connections (tenant_id)
  where kind = 'web' and status <> 'revoked';

-- "Connect Telegram Business" tapped by the owner in @ArchableBot: tells the next business_connection
-- update from this Telegram user which tenant it belongs to.
create table public.channel_link_intents (
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  id            uuid not null default gen_random_uuid(),
  membership_id uuid not null references public.memberships (id),
  tg_user_id    bigint not null,
  expires_at    timestamptz not null default now() + interval '15 minutes',
  consumed_at   timestamptz,
  primary key (tenant_id, id)
);
create index channel_link_intents_open on public.channel_link_intents (tg_user_id, expires_at)
  where consumed_at is null;

-- ───────────────────────────────── web sessions ─────────────────────────────────
-- The public id is the conversation's external_id ('ws_<id>'); only the secret's hash is stored,
-- so staff who can read conversations can't resume a customer's session.

create table public.web_sessions (
  tenant_id            uuid not null references public.tenants (id) on delete cascade,
  id                   uuid not null default gen_random_uuid(),
  env                  text not null default 'prod' check (env = 'prod' or env ~ '^pr-[0-9]+$'),
  secret_hash          bytea not null unique,
  conversation_id      uuid not null,
  embed_origin         text,                            -- host page origin reported by the loader; informational
  verified_customer_id uuid,                            -- set only by a proof (order number + phone)
  created_at           timestamptz not null default now(),
  last_seen_at         timestamptz not null default now(),
  revoked_at           timestamptz,
  primary key (tenant_id, id),
  foreign key (tenant_id, conversation_id) references public.conversations (tenant_id, id) on delete cascade,
  foreign key (tenant_id, verified_customer_id) references public.records (tenant_id, id)
);

-- A person answering in a conversation (the owner in a Business chat, staff from the inbox) pauses the agent there.
alter table public.conversations add column agent_paused_until timestamptz;

-- ───────────────────────────── rationale grounding ─────────────────────────────
-- Basket value and outcome per chapter are written by the Tool Gateway from tool results, in the
-- same transaction as the tool_calls row. Models never write these columns.

alter table public.chapters
  add column last_quote_total bigint check (last_quote_total >= 0),   -- tetri, from the last allowed order.quote
  add column last_quote_at    timestamptz,
  add column order_id         uuid,
  add constraint chapters_order foreign key (tenant_id, order_id) references public.records (tenant_id, id);

-- Which chapters a desire is about. Jev's dedupe links them; owner or developer can unlink.
create table public.desire_chapters (
  tenant_id   uuid not null,
  desire_id   uuid not null,
  chapter_id  uuid not null,
  linked_by   text not null,                            -- 'jev:desire.dedupe' | 'owner' | 'developer'
  p           real check (p between 0 and 1),           -- Jev's probability when linked by Jev
  unlinked_at timestamptz,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, desire_id, chapter_id),
  foreign key (tenant_id, desire_id) references public.desires (tenant_id, id) on delete cascade,
  foreign key (tenant_id, chapter_id) references public.chapters (tenant_id, id) on delete cascade
);

alter table public.desires
  add column rationale_card jsonb;                      -- latest draft card; recomputed as evidence grows

alter table public.change_requests
  add column rationale        jsonb,                    -- RationaleCard frozen for head_sha
  add column rationale_digest text check (rationale_digest ~ '^sha256:[0-9a-f]{64}$');

-- Every number on a rationale card comes from this function. A chapter counts as abandoned when it
-- was quoted, never produced an order, and has been quiet for p_quiet.
create function public.desire_impact(p_tenant uuid, p_desire uuid, p_quiet interval default '2 hours')
returns table (chapters integer, customers integer, quoted integer, abandoned integer,
               abandoned_value bigint, ordered integer, first_seen timestamptz, last_seen timestamptz)
language sql stable set search_path = ''
as $$
  select count(*)::int,
         count(distinct c.customer_id)::int,
         count(*) filter (where c.last_quote_total is not null)::int,
         count(*) filter (where c.last_quote_total is not null and c.order_id is null
                            and c.last_quote_at < now() - p_quiet)::int,
         coalesce(sum(c.last_quote_total) filter (where c.order_id is null
                                                    and c.last_quote_at < now() - p_quiet), 0)::bigint,
         count(*) filter (where c.order_id is not null)::int,
         min(c.opened_at),
         max(coalesce(c.last_quote_at, c.opened_at))
    from public.desire_chapters dc
    join public.chapters c on c.tenant_id = dc.tenant_id and c.id = dc.chapter_id
   where dc.tenant_id = p_tenant and dc.desire_id = p_desire and dc.unlinked_at is null
     and c.env = 'prod'
$$;

-- ─────────────────────── typed confirmation for T3 and T4 ───────────────────────
-- Replaces the Mini App biometric step for the MVP (owner surface is text and buttons only).
-- The code is shown in the prompt, so it is not a secret: it proves the owner read the prompt and
-- answered it on purpose. Compromise resistance comes from the two-person rule (developer + owner).

alter table public.approvals
  add column confirm_mode text not null default 'tap' check (confirm_mode in ('tap', 'typed', 'biometric'));
update public.approvals set confirm_mode = 'biometric' where step_up;
alter table public.approvals
  add constraint approvals_step_up_mode check (step_up = (confirm_mode <> 'tap'));
alter table public.approvals drop constraint approvals_channel_check;
alter table public.approvals add constraint approvals_channel_check
  check (channel in ('telegram_button', 'telegram_typed', 'telegram_mini_app', 'github_review', 'web'));

create table private.approval_challenges (
  id          uuid primary key default gen_random_uuid(),
  approval_id uuid not null references public.approvals (id) on delete cascade,
  tg_user_id  bigint not null,
  tg_chat_id  bigint not null,
  code_hash   bytea not null,                           -- sha256 of the code shown in the prompt
  attempts    smallint not null default 0,
  status      text not null default 'open' check (status in ('open', 'used', 'expired', 'superseded')),
  expires_at  timestamptz not null default now() + interval '120 seconds',
  created_at  timestamptz not null default now()
);
create unique index approval_challenges_one_open on private.approval_challenges (tg_user_id)
  where status = 'open';

-- Tap on "Approve…" for a step-up approval: same bindings as consume_telegram_approval, then a challenge.
create function public.begin_typed_confirmation(
  p_nonce_hash bytea, p_tg_user bigint, p_chat bigint, p_message integer, p_code_hash bytea)
returns table (outcome text, approval_id uuid, change_request_id uuid)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  a public.approvals%rowtype;
  m public.memberships%rowtype;
begin
  select * into a from public.approvals x where x.nonce_hash = p_nonce_hash for update;
  if not found then
    return query select 'unknown'::text, null::uuid, null::uuid;
    return;
  end if;
  select * into m from public.memberships x where x.id = a.approver;
  if m.tg_user_id is distinct from p_tg_user or m.revoked_at is not null then
    outcome := 'wrong_person';
  elsif a.tg_chat_id is distinct from p_chat or a.tg_message_id is distinct from p_message then
    outcome := 'wrong_message';
  elsif a.status <> 'pending' then
    outcome := a.status;
  elsif a.expires_at < now() then
    update public.approvals x set status = 'expired' where x.id = a.id;
    outcome := 'expired';
  elsif a.confirm_mode <> 'typed' then
    outcome := 'not_typed';                               -- tap approvals use consume_telegram_approval
  else
    update private.approval_challenges c set status = 'superseded'
     where c.tg_user_id = p_tg_user and c.status = 'open';
    insert into private.approval_challenges (approval_id, tg_user_id, tg_chat_id, code_hash)
    values (a.id, p_tg_user, p_chat, p_code_hash);
    outcome := 'challenge_open';
  end if;
  return query select outcome, a.id, a.change_request_id;
end
$$;

-- The owner's text reply. At most 5 attempts; the approval must still be pending and unexpired.
create function public.complete_typed_confirmation(
  p_tg_user bigint, p_chat bigint, p_code_hash bytea, p_evidence jsonb)
returns table (outcome text, approval_id uuid, change_request_id uuid, head_sha text)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  c private.approval_challenges%rowtype;
  a public.approvals%rowtype;
begin
  select * into c from private.approval_challenges x
   where x.tg_user_id = p_tg_user and x.status = 'open' for update;
  if not found then
    return query select 'no_challenge'::text, null::uuid, null::uuid, null::text;
    return;
  end if;
  select * into a from public.approvals x where x.id = c.approval_id for update;
  if c.tg_chat_id <> p_chat then
    outcome := 'wrong_chat';
  elsif c.expires_at < now() then
    update private.approval_challenges x set status = 'expired' where x.id = c.id;
    outcome := 'challenge_expired';
  elsif c.code_hash <> p_code_hash then
    update private.approval_challenges x
       set attempts = x.attempts + 1,
           status = case when x.attempts + 1 >= 5 then 'expired' else 'open' end
     where x.id = c.id;
    outcome := 'wrong_code';
  elsif a.status <> 'pending' then
    update private.approval_challenges x set status = 'superseded' where x.id = c.id;
    outcome := a.status;
  elsif a.expires_at < now() then
    update public.approvals x set status = 'expired' where x.id = a.id;
    update private.approval_challenges x set status = 'expired' where x.id = c.id;
    outcome := 'expired';
  else
    update private.approval_challenges x set status = 'used' where x.id = c.id;
    update public.approvals x
       set status = 'approved', channel = 'telegram_typed', decided_at = now(), evidence = p_evidence
     where x.id = a.id;
    outcome := 'approved';
  end if;
  return query select outcome, a.id, a.change_request_id, a.head_sha;
end
$$;

-- ───────────────────────────── ingress resolution ─────────────────────────────
-- Webhooks arrive before the tenant is known, and the plane roles only see their ctx tenant.
-- These definer functions return exactly what routing needs and nothing else.

create function private.resolve_bot_hook(p_hook uuid)
returns table (tenant_id uuid, channel_id uuid, bot_id bigint, hook_secret_hash bytea, token_secret text)
language sql stable security definer set search_path = ''
as $$
  select c.tenant_id, c.id, c.bot_id, c.hook_secret_hash, c.token_secret
    from public.channel_connections c
    join public.tenants t on t.id = c.tenant_id and t.status = 'live'
   where c.hook_id = p_hook and c.kind = 'telegram_bot' and c.status = 'live'
$$;

create function private.resolve_business_connection(p_via_bot bigint, p_connection text)
returns table (tenant_id uuid, channel_id uuid, business_user_id bigint, can_reply boolean)
language sql stable security definer set search_path = ''
as $$
  select c.tenant_id, c.id, c.business_user_id, c.can_reply
    from public.channel_connections c
    join public.tenants t on t.id = c.tenant_id and t.status = 'live'
   where c.business_connection_id = p_connection and c.via_bot_id = p_via_bot
     and c.kind = 'telegram_business' and c.status = 'live'
$$;

-- A business_connection update (connect, edit, disconnect). The tenant comes from the owner's
-- open link intent; without one, the connection is not bound.
create function public.bind_business_connection(
  p_via_bot bigint, p_connection text, p_user bigint, p_user_chat bigint, p_can_reply boolean, p_enabled boolean)
returns table (outcome text, tenant_id uuid)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  i  public.channel_link_intents%rowtype;
  cc public.channel_connections%rowtype;
begin
  select * into cc from public.channel_connections x
   where x.business_connection_id = p_connection and x.kind = 'telegram_business' and x.status <> 'revoked'
   for update;
  if found then                                           -- edit or disconnect of a known connection
    update public.channel_connections x
       set can_reply = p_can_reply,
           status = case when p_enabled then 'live' else 'revoked' end,
           updated_at = now()
     where x.tenant_id = cc.tenant_id and x.id = cc.id;
    return query select case when p_enabled then 'updated' else 'disconnected' end, cc.tenant_id;
    return;
  end if;
  if not p_enabled then
    return query select 'ignored'::text, null::uuid;
    return;
  end if;
  select * into i from public.channel_link_intents x
   where x.tg_user_id = p_user and x.consumed_at is null and x.expires_at > now()
   order by x.expires_at desc limit 1
   for update;
  if not found then
    return query select 'no_intent'::text, null::uuid;
    return;
  end if;
  if not exists (select 1 from public.memberships m
                  where m.id = i.membership_id and m.role = 'owner'
                    and m.tg_user_id = p_user and m.revoked_at is null) then
    return query select 'not_owner'::text, null::uuid;
    return;
  end if;
  update public.channel_link_intents x set consumed_at = now() where x.tenant_id = i.tenant_id and x.id = i.id;
  insert into public.channel_connections (tenant_id, channel_key, kind, via_bot_id, business_connection_id,
                                          business_user_id, business_user_chat_id, can_reply, connected_by)
  values (i.tenant_id, 'tg_business', 'telegram_business', p_via_bot, p_connection,
          p_user, p_user_chat, p_can_reply, i.membership_id);
  return query select 'bound'::text, i.tenant_id;
end
$$;

-- Owner pasted a BotFather token in @ArchableBot: store it in Vault, then bind the hook.
create function public.bind_tenant_bot(
  p_tenant uuid, p_membership uuid, p_bot_id bigint, p_username text, p_token text, p_hook uuid, p_secret_hash bytea)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_slug text;
  v_name text;
  v_id   uuid;
begin
  if not exists (select 1 from public.memberships m
                  where m.id = p_membership and m.tenant_id = p_tenant and m.role = 'owner'
                    and m.revoked_at is null) then
    raise exception 'only the owner can connect a channel' using errcode = '42501';
  end if;
  select t.slug into v_slug from public.tenants t where t.id = p_tenant;
  v_name := v_slug || '/tg_bot_token';
  delete from vault.secrets where name = v_name;          -- replacing a token: the old one is dead
  perform vault.create_secret(p_token, v_name, 'tenant bot token');
  update public.channel_connections c set status = 'revoked', updated_at = now()
   where c.tenant_id = p_tenant and c.kind = 'telegram_bot' and c.status <> 'revoked';
  insert into public.channel_connections (tenant_id, channel_key, kind, bot_id, bot_username, hook_id,
                                          hook_secret_hash, token_secret, connected_by)
  values (p_tenant, 'tg_customers', 'telegram_bot', p_bot_id, p_username, p_hook, p_secret_hash, v_name, p_membership)
  returning id into v_id;
  return v_id;
end
$$;

-- Web chat: open or resume a session. The tenant must be live and have web chat turned on.
create function public.open_web_session(p_slug text, p_env text, p_secret_hash bytea, p_origin text)
returns table (tenant_id uuid, session_id uuid, conversation_id uuid)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_tenant uuid;
  v_sid    uuid := gen_random_uuid();
  v_conv   uuid;
begin
  if p_env <> 'prod' and p_env !~ '^pr-[0-9]+$' then
    raise exception 'bad env' using errcode = '22023';
  end if;
  select t.id into v_tenant
    from public.tenants t
    join public.channel_connections c on c.tenant_id = t.id and c.kind = 'web' and c.status = 'live'
   where t.slug = p_slug and t.status = 'live';
  if v_tenant is null then
    return;                                               -- empty result: unknown tenant or chat off
  end if;
  insert into public.conversations (tenant_id, env, channel, external_id)
  values (v_tenant, p_env, 'web', 'ws_' || v_sid)
  returning id into v_conv;
  insert into public.web_sessions (tenant_id, id, env, secret_hash, conversation_id, embed_origin)
  values (v_tenant, v_sid, p_env, p_secret_hash, v_conv, left(p_origin, 200));
  return query select v_tenant, v_sid, v_conv;
end
$$;

create function public.resume_web_session(p_secret_hash bytea)
returns table (tenant_id uuid, session_id uuid, conversation_id uuid, env text)
language sql security definer set search_path = ''
as $$
  update public.web_sessions s set last_seen_at = now()
   where s.secret_hash = p_secret_hash and s.revoked_at is null
     and exists (select 1 from public.tenants t where t.id = s.tenant_id and t.status = 'live')
  returning s.tenant_id, s.id, s.conversation_id, s.env
$$;

-- ──────────────────────────── A2A graph: edge statistics ────────────────────────────

create index tool_calls_edge on public.tool_calls (tenant_id, tool, caller, created_at desc);

create function private.tool_calls_broadcast() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform realtime.send(jsonb_build_object('id', new.id, 'caller', new.caller, 'tool', new.tool,
                                           'decision', new.decision, 'status', new.status,
                                           'latency_ms', new.latency_ms, 'turn_id', new.turn_id),
                        'tool_call', 'tenant:' || new.tenant_id, true);
  return null;
end
$$;
create trigger tool_calls_broadcast after insert on public.tool_calls
  for each row execute function private.tool_calls_broadcast();

-- ───────────────────────────────── RLS and grants ─────────────────────────────────

do $$
declare
  t text;
begin
  foreach t in array array['channel_connections', 'channel_link_intents', 'web_sessions', 'desire_chapters'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for all to archable_runtime, archable_control '
                   'using (tenant_id = private.ctx_tenant()) with check (tenant_id = private.ctx_tenant())',
                   t || '_planes', t);
  end loop;
end
$$;
create policy channel_connections_owner_dev_read on public.channel_connections for select to authenticated
  using (private.has_role(tenant_id, array['owner', 'developer']));
create policy desire_chapters_owner_dev_read on public.desire_chapters for select to authenticated
  using (private.has_role(tenant_id, array['owner', 'developer']));

revoke all on public.channel_connections, public.channel_link_intents, public.web_sessions,
              public.desire_chapters from anon, authenticated;
grant select (tenant_id, id, channel_key, kind, status, bot_username, can_reply, created_at)
  on public.channel_connections to authenticated;
grant select on public.desire_chapters to authenticated;

grant select on public.channel_connections to archable_runtime;
grant select, update on public.web_sessions to archable_runtime;
grant select, insert, update, delete on public.channel_connections, public.channel_link_intents,
                                       public.web_sessions, public.desire_chapters to archable_control;

revoke execute on all functions in schema private from public;
revoke execute on function public.desire_impact(uuid, uuid, interval),
                           public.begin_typed_confirmation(bytea, bigint, bigint, integer, bytea),
                           public.complete_typed_confirmation(bigint, bigint, bytea, jsonb),
                           public.bind_business_connection(bigint, text, bigint, bigint, boolean, boolean),
                           public.bind_tenant_bot(uuid, uuid, bigint, text, text, uuid, bytea),
                           public.open_web_session(text, text, bytea, text),
                           public.resume_web_session(bytea)
  from public, anon, authenticated;
grant execute on function private.resolve_bot_hook(uuid),
                          private.resolve_business_connection(bigint, text),
                          public.open_web_session(text, text, bytea, text),
                          public.resume_web_session(bytea)
  to archable_runtime;
grant execute on function private.ctx_tenant(), private.first_seen(bigint, bigint),
                          private.resolve_business_connection(bigint, text),
                          public.desire_impact(uuid, uuid, interval),
                          public.begin_typed_confirmation(bytea, bigint, bigint, integer, bytea),
                          public.complete_typed_confirmation(bigint, bigint, bytea, jsonb),
                          public.bind_business_connection(bigint, text, bigint, bigint, boolean, boolean),
                          public.bind_tenant_bot(uuid, uuid, bigint, text, text, uuid, bytea)
  to archable_control;
grant execute on function private.tool_calls_broadcast() to archable_runtime, archable_control;

select cron.schedule('challenges-expire', '* * * * *',
  $$update private.approval_challenges set status = 'expired' where status = 'open' and expires_at < now()$$);
select cron.schedule('link-intents-drop', '23 * * * *',
  $$delete from public.channel_link_intents where expires_at < now() - interval '1 day'$$);

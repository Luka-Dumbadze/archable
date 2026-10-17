-- supabase/migrations/20261017000000_archable_v3.sql
-- Archable v3 core schema (Supabase, Postgres 17). Facts only: definitions live in Git (I1).

create extension if not exists pg_jsonschema with schema extensions;
create extension if not exists pgmq;
create extension if not exists pg_cron;

create schema if not exists private;                  -- not exposed through the Data API

-- One login role per plane; neither bypasses RLS. Passwords are set out of band, and through
-- Supavisor (transaction mode, port 6543) they connect as archable_runtime.<project-ref>.
create role archable_runtime login noinherit nobypassrls;
create role archable_control login noinherit nobypassrls;

-- ─────────────────────────────── tenancy and people ───────────────────────────────

create table public.tenants (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique
                  check (slug ~ '^[a-z][a-z0-9-]{1,30}[a-z0-9]$' and slug !~ '--'),  -- '--' is reserved for previews
  name            text not null,
  os_name         text not null,                         -- 'Marani OS'
  status          text not null default 'provisioning'
                  check (status in ('provisioning', 'live', 'suspended', 'exported')),
  active_digest   text,                                  -- null until the first flip
  epoch           bigint not null default 0,
  repo_full_name  text unique,                           -- 'archable-tenants/marani'
  installation_id bigint,
  custom_domain   text unique,
  desire_seq      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table public.memberships (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  role           text not null check (role in ('owner', 'developer', 'staff')),
  display_name   text not null,
  user_id        uuid references auth.users (id) on delete set null,   -- web session
  tg_user_id     bigint,                                              -- Telegram identity
  github_user_id bigint,                                              -- proven by the device flow
  github_login   text,
  created_at     timestamptz not null default now(),
  revoked_at     timestamptz,
  unique (tenant_id, user_id),
  unique (tenant_id, tg_user_id),
  unique (tenant_id, github_user_id)
);
create unique index memberships_one_owner on public.memberships (tenant_id)
  where role = 'owner' and revoked_at is null;
create index memberships_by_user on public.memberships (user_id) where revoked_at is null;

-- ───────────────────── compiled definitions (immutable per digest) ─────────────────────

create table public.specs (
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  digest           text not null check (digest ~ '^sha256:[0-9a-f]{64}$'),
  git_sha          text not null,
  compiler_version text not null,
  bundle           jsonb not null,                       -- RFC 8785 canonical bundle, graph included
  extension_digest text,                                 -- tenant UI extension bundle, if any
  state            text not null default 'candidate'
                   check (state in ('candidate', 'preview', 'active', 'draining', 'retired')),
  verified_at      timestamptz,                          -- archable/verify passed for git_sha
  drain_until      timestamptz,
  created_at       timestamptz not null default now(),
  primary key (tenant_id, digest)
);
create unique index specs_one_active on public.specs (tenant_id) where state = 'active';

alter table public.tenants
  add constraint tenants_active_bundle foreign key (id, active_digest)
  references public.specs (tenant_id, digest) deferrable initially deferred;

create table public.entity_schemas (                    -- projection of one bundle, written at registration
  tenant_id   uuid not null,
  spec_digest text not null,
  entity_type text not null,
  json_schema jsonb not null,
  key_field   text,                                      -- the object's `key`, copied into records.natural_key
  title_field text not null,
  edit_roles  text[] not null default '{owner,developer}',   -- who may write this object from the shell
  field_acl   jsonb not null default '{}',               -- {"payout_rate": ["owner"]}
  primary key (tenant_id, spec_digest, entity_type),
  foreign key (tenant_id, spec_digest) references public.specs (tenant_id, digest) on delete cascade
);

create table public.apps (                              -- projection of one bundle
  tenant_id   uuid not null,
  spec_digest text not null,
  app_id      text not null,                             -- 'contact_center'
  template    text not null,                             -- 'tpl.contact_center@3'
  agent_id    text,
  title       text not null,
  nav_order   smallint not null default 0,
  primary key (tenant_id, spec_digest, app_id),
  foreign key (tenant_id, spec_digest) references public.specs (tenant_id, digest) on delete cascade
);

create view public.active_apps with (security_invoker = true) as
  select a.*
    from public.apps a
    join public.tenants t on t.id = a.tenant_id and t.active_digest = a.spec_digest;

-- ──────────────────────────────── facts: records ────────────────────────────────

create table public.records (
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  id           uuid not null default gen_random_uuid(),
  env          text not null default 'prod' check (env = 'prod' or env ~ '^pr-[0-9]+$'),
  entity_type  text not null,
  natural_key  text,                                     -- set by the trigger from the object's key field
  display_name text not null default '',
  attrs        jsonb not null default '{}',
  spec_digest  text not null,                            -- the bundle the writer was pinned to
  version      integer not null default 1,               -- optimistic concurrency: update … where version = $n
  search       tsvector,
  provenance   jsonb,                                    -- mined rows: capture sha256, bbox, extractor
  created_by   text not null,                            -- 'user:<uuid>' | 'agent:<id>' | 'import' | 'architect'
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, spec_digest) references public.specs (tenant_id, digest)
);
create unique index records_natural_key on public.records (tenant_id, env, entity_type, natural_key)
  where natural_key is not null;
create index records_recent on public.records (tenant_id, env, entity_type, updated_at desc);
create index records_attrs on public.records using gin (attrs jsonb_path_ops);
create index records_search on public.records using gin (search);

-- Runs with the caller's rights, so RLS and grants apply to its lookups and current_user is the caller.
create function private.records_before_write() returns trigger
language plpgsql set search_path = ''
as $$
declare
  s     record;
  prev  jsonb;
  field text;
  roles text[];
begin
  select es.json_schema, es.key_field, es.title_field, es.edit_roles, es.field_acl, sp.state
    into s
    from public.entity_schemas es
    join public.specs sp on sp.tenant_id = es.tenant_id and sp.digest = es.spec_digest
   where es.tenant_id = new.tenant_id
     and es.spec_digest = new.spec_digest
     and es.entity_type = new.entity_type;
  if not found then
    raise exception 'unknown object "%" in bundle %', new.entity_type, new.spec_digest
      using errcode = '23514';
  end if;
  if s.state = 'retired' or (new.env = 'prod' and s.state not in ('active', 'draining')) then
    raise exception 'bundle % is %; production writes need the active bundle', new.spec_digest, s.state
      using errcode = '23514';
  end if;
  if not extensions.jsonb_matches_schema(s.json_schema::json, new.attrs) then
    raise exception 'attrs do not match the "%" schema', new.entity_type using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' then
    prev := old.attrs;
  end if;

  -- Shell writes obey the spec's object and field edit roles; agents are governed by Cedar instead.
  if current_user = 'authenticated' then
    roles := array(select m.role from public.memberships m
                    where m.tenant_id = new.tenant_id and m.user_id = auth.uid() and m.revoked_at is null);
    if not (roles && s.edit_roles) then
      raise exception 'your role cannot edit "%"', new.entity_type using errcode = '42501';
    end if;
    for field in select jsonb_object_keys(s.field_acl) loop
      if new.attrs -> field is distinct from prev -> field
         and not (roles && array(select jsonb_array_elements_text(s.field_acl -> field))) then
        raise exception 'your role cannot edit "%.%"', new.entity_type, field using errcode = '42501';
      end if;
    end loop;
  end if;

  new.natural_key  := case when s.key_field is null then null else new.attrs ->> s.key_field end;
  new.display_name := coalesce(new.attrs ->> s.title_field, new.natural_key, '');
  new.search       := jsonb_to_tsvector('simple'::regconfig, new.attrs, '["string"]'::jsonb);  -- no Georgian stemmer: 'simple'
  if tg_op = 'UPDATE' then
    new.version    := old.version + 1;
    new.updated_at := now();
  end if;
  return new;
end
$$;

create trigger records_before_write
  before insert or update on public.records
  for each row execute function private.records_before_write();

-- ─────────────────────────── facts: conversations ───────────────────────────

create table public.chapters (                          -- one incident lifecycle, across channels
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  id          uuid not null default gen_random_uuid(),
  env         text not null default 'prod',
  customer_id uuid,
  kind        text not null,                             -- the route.intent label that opened it
  status      text not null default 'open'
              check (status in ('open', 'waiting_customer', 'waiting_staff', 'resolved')),
  summary     text,
  opened_at   timestamptz not null default now(),
  resolved_at timestamptz,
  primary key (tenant_id, id),
  foreign key (tenant_id, customer_id) references public.records (tenant_id, id)
);
create index chapters_open on public.chapters (tenant_id, env, status) where status <> 'resolved';

create table public.conversations (
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  id              uuid not null default gen_random_uuid(),
  env             text not null default 'prod',
  channel         text not null
                  check (channel in ('telegram', 'telegram_business', 'whatsapp', 'instagram', 'web')),
  external_id     text not null,                         -- chat id on the channel
  customer_id     uuid,
  active_chapter  uuid,
  last_message_at timestamptz,
  created_at      timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, env, channel, external_id),
  foreign key (tenant_id, customer_id) references public.records (tenant_id, id),
  foreign key (tenant_id, active_chapter) references public.chapters (tenant_id, id)
);

create table public.messages (
  tenant_id       uuid not null,
  id              bigint generated always as identity,
  conversation_id uuid not null,
  chapter_id      uuid,
  turn_id         uuid not null,
  direction       text not null check (direction in ('in', 'out')),
  author          text not null,                         -- 'customer' | 'agent:cellar_master' | 'staff:<membership>'
  body            text,
  media           jsonb,                                 -- [{path, mime, sha256}] in the media bucket
  spec_digest     text not null,                         -- the bundle this turn was pinned to
  external_id     text,                                  -- channel message id
  created_at      timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, conversation_id, direction, external_id),
  foreign key (tenant_id, conversation_id) references public.conversations (tenant_id, id) on delete cascade,
  foreign key (tenant_id, chapter_id) references public.chapters (tenant_id, id)
);
create index messages_by_conversation on public.messages (tenant_id, conversation_id, id desc);

-- ───────────────────────────── facts: evidence and audit ─────────────────────────────

create table public.decision_log (
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  id           bigint generated always as identity,
  turn_id      uuid not null,
  head         text not null,                            -- 'send.grounded'
  stage        text not null check (stage in ('route', 'pre_send', 'architect', 'governance')),
  model        text not null,                            -- 'rule' | 'typesafe-ai/jev' | 'google/gemini-3.8-flash'
  fallback     boolean not null default false,           -- the gateway's conditional stage answered
  input_digest text not null,                            -- sha256 of the exact state judged
  answer       jsonb not null,                           -- {type, choice | probability | score, probabilities}
  verdict      text not null,                            -- 'order_new' | 'pass' | 'fail' | 'timeout'
  latency_ms   integer not null,
  created_at   timestamptz not null default now(),
  primary key (tenant_id, id)
);

create table public.tool_calls (
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  id              bigint generated always as identity,
  turn_id         uuid,
  env             text not null default 'prod',
  caller          text not null,                         -- 'agent:cellar_master' | 'mcp:elva:<key id>' | 'user:<uuid>'
  tool            text not null,
  args_digest     text not null,
  decision        text not null check (decision in ('allow', 'deny')),
  policies        text[] not null default '{}',          -- Cedar policy ids behind the decision
  status          text not null check (status in ('ok', 'error', 'denied', 'simulated')),
  idempotency_key text,
  latency_ms      integer,
  created_at      timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, env, tool, idempotency_key)
);

-- ─────────────────────────────── evolution loop ───────────────────────────────

create table public.desires (                           -- the Structured Desires Feed
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  id          uuid not null default gen_random_uuid(),
  number      integer not null,                          -- D-14; assigned by trigger
  source      text not null
              check (source in ('owner_request', 'failure_cluster', 'developer_note', 'kpi_drift')),
  statement   text not null,                             -- 'Customers can pay cash on delivery up to 300 GEL'
  rationale   text,
  evidence    jsonb not null default '[]',               -- message ids, failure ids, counts, transcripts
  changeset   jsonb,                                     -- typed ops, once drafted
  affected    text[] not null default '{}',              -- graph nodes from the dry-run blast radius
  tier        smallint check (tier between 0 and 4),
  status      text not null default 'open'
              check (status in ('open', 'drafting', 'in_review', 'awaiting_owner', 'live', 'declined', 'merged_elsewhere')),
  assignee    text not null default 'architect' check (assignee in ('architect', 'developer')),
  occurrences integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, number)
);

create function private.desires_number() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update public.tenants set desire_seq = desire_seq + 1
   where id = new.tenant_id
  returning desire_seq into new.number;
  return new;
end
$$;

create trigger desires_number
  before insert on public.desires
  for each row execute function private.desires_number();

create table public.failures (
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  id         bigint generated always as identity,
  turn_id    uuid,
  kind       text not null check (kind in ('grounding_block', 'policy_deny', 'tool_error', 'customer_frustration',
                                           'staff_correction', 'human_takeover', 'deadline', 'eval_regression')),
  severity   smallint not null check (severity between 1 and 5),
  desire_id  uuid,                                       -- cluster membership, set by the Architect's dedupe
  payload    jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, desire_id) references public.desires (tenant_id, id)
);
create index failures_unclustered on public.failures (tenant_id, created_at) where desire_id is null;

create table public.change_requests (                   -- one row per PR, for its whole life
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  id            uuid not null default gen_random_uuid(),
  desire_id     uuid,
  pr_number     integer not null,
  title         text not null,
  author_kind   text not null check (author_kind in ('architect', 'developer', 'lovable_studio')),
  model         text,                                    -- patch model for Architect PRs (merged-PR index)
  base_sha      text not null,
  head_sha      text not null,
  delta_digest  text,                                    -- hash of Δ: changed node ids and hashes
  bundle_digest text,                                    -- compiled head bundle (preview epoch)
  tier          smallint check (tier between 0 and 4),
  blast_radius  jsonb,                                   -- {changed, reached, why: [{tier, rule, path}]}
  verification  jsonb,                                   -- {compile, suites: {name: {passes, runs, wilson_lb}}, elva_drift}
  state         text not null default 'verifying'
                check (state in ('verifying', 'failed', 'needs_developer', 'needs_owner', 'approved',
                                 'merging', 'merged', 'closed', 'superseded')),
  merged_sha    text,
  reverted_by   uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, pr_number),
  foreign key (tenant_id, desire_id) references public.desires (tenant_id, id)
);

create view public.pending_prs with (security_invoker = true) as
  select *
    from public.change_requests
   where state in ('verifying', 'failed', 'needs_developer', 'needs_owner', 'approved', 'merging');

create table public.approvals (                         -- the ledger behind archable/approval
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  change_request_id uuid not null,
  role              text not null check (role in ('developer', 'owner')),
  approver          uuid not null references public.memberships (id),
  channel           text not null check (channel in ('telegram_button', 'telegram_mini_app', 'github_review', 'web')),
  nonce_hash        bytea unique,                        -- sha256 of the button nonce
  tg_chat_id        bigint,
  tg_message_id     integer,
  head_sha          text not null,
  delta_digest      text not null,
  summary_digest    text not null,                       -- sha256 of the exact text the approver saw
  tier              smallint not null check (tier between 0 and 4),
  step_up           boolean not null default false,      -- T3 and T4: Mini App + biometric only
  status            text not null default 'pending'
                    check (status in ('pending', 'approved', 'rejected', 'expired', 'superseded')),
  evidence          jsonb,                               -- update_id, callback id, initData hash, device id, review id
  expires_at        timestamptz not null,
  decided_at        timestamptz,
  created_at        timestamptz not null default now(),
  foreign key (tenant_id, change_request_id) references public.change_requests (tenant_id, id) on delete cascade
);
create unique index approvals_one_pending on public.approvals (change_request_id, role, approver)
  where status = 'pending';
create index approvals_by_head on public.approvals (change_request_id, head_sha);

create table public.developer_invites (
  tenant_id            uuid not null references public.tenants (id) on delete cascade,
  id                   uuid not null default gen_random_uuid(),
  invited_by           uuid not null references public.memberships (id),
  expected_tg_username text,                             -- the owner's hint, not an identity
  token_hash           bytea not null unique,            -- sha256 of the t.me deep-link token
  tg_user_id           bigint,                           -- bound when the link is opened
  github_user_id       bigint,                           -- bound after the device flow
  github_login         text,
  github_invitation_id bigint,
  status               text not null default 'created'
                       check (status in ('created', 'opened', 'github_verified', 'invited', 'accepted',
                                         'revoked', 'expired')),
  expires_at           timestamptz not null default now() + interval '72 hours',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  primary key (tenant_id, id)
);

-- ─────────────────────────────── platform internals ───────────────────────────────

create table private.telegram_updates (
  bot_id      bigint not null,
  update_id   bigint not null,
  received_at timestamptz not null default now(),
  primary key (bot_id, update_id)
);

create table private.step_up_devices (
  membership_id uuid not null references public.memberships (id) on delete cascade,
  device_id     text not null,                           -- BiometricManager.deviceId
  token_hash    bytea not null,                          -- sha256 of the token in Telegram's secure storage
  enrolled_at   timestamptz not null default now(),
  revoked_at    timestamptz,
  primary key (membership_id, device_id)
);

-- ─────────────────────────────── helper functions ───────────────────────────────

create function private.my_tenants() returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select m.tenant_id from public.memberships m
   where m.user_id = (select auth.uid()) and m.revoked_at is null
$$;

create function private.has_role(p_tenant uuid, p_roles text[]) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.memberships m
                  where m.tenant_id = p_tenant and m.user_id = (select auth.uid())
                    and m.revoked_at is null and m.role = any (p_roles))
$$;

-- The planes set the tenant per transaction: select set_config('app.tenant_id', $1, true)
create function private.ctx_tenant() returns uuid
language sql stable set search_path = ''
as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

create function private.first_seen(p_bot bigint, p_update bigint) returns boolean
language sql security definer set search_path = ''
as $$
  with ins as (
    insert into private.telegram_updates (bot_id, update_id) values (p_bot, p_update)
    on conflict do nothing
    returning 1
  )
  select exists (select 1 from ins)
$$;

-- Last-hop secret injection: a plane can read only secrets named '<its tenant's slug>/…'.
create function private.channel_secret(p_name text) returns text
language sql stable security definer set search_path = ''
as $$
  select s.decrypted_secret
    from vault.decrypted_secrets s
    join public.tenants t on t.id = private.ctx_tenant()
   where s.name = p_name and split_part(p_name, '/', 1) = t.slug
$$;

-- Epoch flip: compare-and-set on one pointer, then broadcast.
create function public.flip_epoch(p_tenant uuid, p_expected_epoch bigint, p_digest text)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_prev  text;
  v_epoch bigint;
begin
  select t.active_digest into v_prev from public.tenants t where t.id = p_tenant for update;
  if not found then
    raise exception 'unknown tenant %', p_tenant using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.specs s
                  where s.tenant_id = p_tenant and s.digest = p_digest and s.verified_at is not null) then
    raise exception 'bundle % is not verified for tenant %', p_digest, p_tenant using errcode = '23514';
  end if;
  update public.tenants t
     set active_digest = p_digest, epoch = t.epoch + 1, updated_at = now()
   where t.id = p_tenant and t.epoch = p_expected_epoch
  returning t.epoch into v_epoch;
  if v_epoch is null then
    raise exception 'epoch moved: expected %', p_expected_epoch using errcode = '40001';
  end if;
  if v_prev is not null and v_prev <> p_digest then
    update public.specs s set state = 'draining', drain_until = now() + interval '15 minutes'
     where s.tenant_id = p_tenant and s.digest = v_prev;
  end if;
  update public.specs s set state = 'active', drain_until = null
   where s.tenant_id = p_tenant and s.digest = p_digest;
  perform realtime.send(jsonb_build_object('epoch', v_epoch, 'digest', p_digest),
                        'epoch_flip', 'tenant:' || p_tenant, true);
  return v_epoch;
end
$$;

-- A Telegram button tap: every binding of §4.5, checked under one row lock.
create function public.consume_telegram_approval(
  p_nonce_hash bytea, p_tg_user bigint, p_chat bigint, p_message integer, p_decision text, p_evidence jsonb)
returns table (outcome text, approval_id uuid, change_request_id uuid, head_sha text)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  a public.approvals%rowtype;
  m public.memberships%rowtype;
begin
  if p_decision not in ('approve', 'reject') then
    raise exception 'decision must be approve or reject' using errcode = '22023';
  end if;
  select * into a from public.approvals x where x.nonce_hash = p_nonce_hash for update;
  if not found then
    return query select 'unknown'::text, null::uuid, null::uuid, null::text;
    return;
  end if;
  select * into m from public.memberships x where x.id = a.approver;
  if m.tg_user_id is distinct from p_tg_user or m.revoked_at is not null then
    outcome := 'wrong_person';
  elsif a.tg_chat_id is distinct from p_chat or a.tg_message_id is distinct from p_message then
    outcome := 'wrong_message';
  elsif a.status <> 'pending' then
    outcome := a.status;                                  -- already decided, expired or superseded
  elsif a.expires_at < now() then
    update public.approvals x set status = 'expired' where x.id = a.id;
    outcome := 'expired';
  elsif a.step_up and p_decision = 'approve' then
    outcome := 'step_up_required';                        -- T3/T4: only the Mini App can approve
  else
    update public.approvals x
       set status = case p_decision when 'approve' then 'approved' else 'rejected' end,
           decided_at = now(), evidence = p_evidence
     where x.id = a.id;
    outcome := case p_decision when 'approve' then 'approved' else 'rejected' end;
  end if;
  return query select outcome, a.id, a.change_request_id, a.head_sha;
end
$$;

-- A Mini App approval for T3/T4: identity, enrolled device, biometric token, summary digest.
create function public.approve_with_step_up(
  p_approval uuid, p_tg_user bigint, p_device_id text, p_token_hash bytea, p_summary_digest text, p_evidence jsonb)
returns table (outcome text, change_request_id uuid)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  a public.approvals%rowtype;
  m public.memberships%rowtype;
begin
  select * into a from public.approvals x where x.id = p_approval for update;
  if not found then
    return query select 'unknown'::text, null::uuid;
    return;
  end if;
  select * into m from public.memberships x where x.id = a.approver;
  if m.tg_user_id is distinct from p_tg_user or m.revoked_at is not null then
    outcome := 'wrong_person';
  elsif not exists (select 1 from private.step_up_devices d
                     where d.membership_id = m.id and d.device_id = p_device_id
                       and d.token_hash = p_token_hash and d.revoked_at is null) then
    outcome := 'device_not_enrolled';
  elsif a.summary_digest <> p_summary_digest then
    outcome := 'summary_mismatch';
  elsif a.status <> 'pending' then
    outcome := a.status;
  elsif a.expires_at < now() then
    update public.approvals x set status = 'expired' where x.id = a.id;
    outcome := 'expired';
  else
    update public.approvals x
       set status = 'approved', decided_at = now(), evidence = p_evidence
     where x.id = a.id;
    outcome := 'approved';
  end if;
  return query select outcome, a.change_request_id;
end
$$;

-- ──────────────────────────────── row-level security ────────────────────────────────

alter table public.tenants enable row level security;
create policy tenants_planes on public.tenants for all to archable_runtime, archable_control
  using (id = private.ctx_tenant()) with check (id = private.ctx_tenant());
create policy tenants_members_read on public.tenants for select to authenticated
  using (id in (select private.my_tenants()));

do $$
declare
  t text;
begin
  foreach t in array array['memberships', 'specs', 'entity_schemas', 'apps', 'records', 'chapters',
                           'conversations', 'messages', 'decision_log', 'tool_calls', 'failures', 'desires',
                           'change_requests', 'approvals', 'developer_invites'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for all to archable_runtime, archable_control '
                   'using (tenant_id = private.ctx_tenant()) with check (tenant_id = private.ctx_tenant())',
                   t || '_planes', t);
  end loop;
  foreach t in array array['memberships', 'specs', 'entity_schemas', 'apps', 'records', 'chapters',
                           'conversations', 'messages', 'decision_log', 'tool_calls', 'failures'] loop
    execute format('create policy %I on public.%I for select to authenticated '
                   'using (tenant_id in (select private.my_tenants()))', t || '_members_read', t);
  end loop;
  foreach t in array array['desires', 'change_requests', 'approvals', 'developer_invites'] loop
    execute format('create policy %I on public.%I for select to authenticated '
                   'using (private.has_role(tenant_id, array[''owner'', ''developer'']))', t || '_owner_dev_read', t);
  end loop;
end
$$;

-- Shell edits to records; object and field edit roles are enforced by the trigger.
create policy records_members_insert on public.records for insert to authenticated
  with check (tenant_id in (select private.my_tenants()));
create policy records_members_update on public.records for update to authenticated
  using (tenant_id in (select private.my_tenants()))
  with check (tenant_id in (select private.my_tenants()));

-- Realtime: members receive broadcasts on their tenants' private topics only.
create policy tenant_topic_members on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and (select realtime.topic()) like 'tenant:%'
    and split_part((select realtime.topic()), ':', 2)::uuid in (select private.my_tenants())
  );

-- Storage: media objects live under '<tenant_id>/…'.
create policy media_members_read on storage.objects for select to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1]::uuid in (select private.my_tenants()));

-- ─────────────────────────────────── grants ───────────────────────────────────

revoke all on all tables in schema public from anon;
revoke insert, update, delete on all tables in schema public from authenticated;
grant insert, update on public.records to authenticated;
revoke select on public.specs from authenticated;            -- members see bundle metadata, not prompts or policies
grant select (tenant_id, digest, git_sha, state, verified_at, created_at) on public.specs to authenticated;

grant usage on schema public, private to authenticated, archable_runtime, archable_control;
grant select on public.tenants, public.memberships, public.specs, public.entity_schemas, public.apps
  to archable_runtime;
grant select, insert, update on public.records, public.chapters, public.conversations, public.messages
  to archable_runtime;
grant select, insert on public.decision_log, public.tool_calls, public.failures to archable_runtime;
grant select, insert, update, delete on all tables in schema public to archable_control;
grant select, insert, update on private.step_up_devices to archable_control;    -- Mini App enrollment

revoke execute on all functions in schema private from public;
revoke execute on function public.flip_epoch(uuid, bigint, text),
                           public.consume_telegram_approval(bytea, bigint, bigint, integer, text, jsonb),
                           public.approve_with_step_up(uuid, bigint, text, bytea, text, jsonb)
  from public, anon, authenticated;
grant execute on function private.my_tenants(), private.has_role(uuid, text[]) to authenticated;
grant execute on function private.ctx_tenant(), private.first_seen(bigint, bigint),
                          private.channel_secret(text), private.records_before_write()
  to archable_runtime, archable_control;
grant execute on function private.records_before_write() to authenticated;
grant execute on function public.flip_epoch(uuid, bigint, text),
                          public.consume_telegram_approval(bytea, bigint, bigint, integer, text, jsonb),
                          public.approve_with_step_up(uuid, bigint, text, bytea, text, jsonb)
  to archable_control;

-- ──────────────────────────────── queues and schedules ────────────────────────────────

select pgmq.create('architect');      -- failure clustering, desire drafting
select pgmq.create('verify');         -- PR verification, fanned out per suite
select pgmq.create('audit');          -- post-send audits

select cron.schedule('approvals-expire', '* * * * *',
  $$update public.approvals set status = 'expired' where status = 'pending' and expires_at < now()$$);
select cron.schedule('bundles-retire', '*/5 * * * *',
  $$update public.specs set state = 'retired' where state = 'draining' and drain_until < now()$$);
select cron.schedule('previews-drop', '17 3 * * *',
  $$delete from public.records r using public.change_requests c
     where r.tenant_id = c.tenant_id and r.env = 'pr-' || c.pr_number
       and c.state in ('merged', 'closed', 'superseded')$$);

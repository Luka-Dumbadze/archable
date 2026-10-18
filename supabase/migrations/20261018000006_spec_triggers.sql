-- supabase/migrations/20261018000006_spec_triggers.sql
-- Spec triggers (v3 §6 `triggers`, plan §1.5 notify_on_job_status). A record write that moves a field onto one of a
-- trigger's values enqueues a job on pgmq 'triggers'; the API drains it and calls the trigger's tool through the Tool
-- Gateway as Trigger::"<id>" (plan §5.5). Only transitions enqueue: writing the same value again does not, so a retried
-- status update can't notify twice. Each job carries the record's version, which the drain uses as the idempotency key.

select pgmq.create('triggers');

create function private.records_spec_triggers() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  t record;
  v text;
begin
  for t in
    select key as id, value as def
      from public.specs s, jsonb_each(coalesce(s.bundle -> 'triggers', '{}'))
     where s.tenant_id = new.tenant_id and s.digest = new.spec_digest     -- writes carry their bundle (v3 §7.3)
       and value ->> 'object' = new.entity_type
  loop
    v := new.attrs ->> (t.def ->> 'field');
    if v is not null
       and v in (select jsonb_array_elements_text(t.def -> 'values'))
       and (tg_op = 'INSERT' or (old.attrs ->> (t.def ->> 'field')) is distinct from v) then
      perform pgmq.send('triggers', jsonb_build_object(
        'tenant_id', new.tenant_id, 'env', new.env, 'digest', new.spec_digest, 'trigger', t.id, 'call', t.def ->> 'call',
        'object', new.entity_type, 'record_id', new.id, 'value', v, 'version', new.version));
    end if;
  end loop;
  return null;
end
$$;

create trigger records_spec_triggers
  after insert or update of attrs on public.records
  for each row execute function private.records_spec_triggers();

-- The drain runs as archable_runtime, which has no pgmq access of its own.
create function private.triggers_read(p_qty integer, p_vt integer default 30)
returns table (msg_id bigint, read_ct integer, message jsonb)
language sql security definer set search_path = ''
as $$ select r.msg_id, r.read_ct, r.message from pgmq.read('triggers', p_vt, p_qty) r $$;

create function private.triggers_archive(p_msg_id bigint) returns boolean
language sql security definer set search_path = ''
as $$ select pgmq.archive('triggers', p_msg_id) $$;

revoke execute on function private.records_spec_triggers(), private.triggers_read(integer, integer),
                           private.triggers_archive(bigint) from public, anon, authenticated;
grant execute on function private.triggers_read(integer, integer), private.triggers_archive(bigint) to archable_runtime;

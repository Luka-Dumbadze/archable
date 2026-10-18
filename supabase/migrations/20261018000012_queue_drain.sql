-- supabase/migrations/20261018000012_queue_drain.sql (P4.D2.8)
-- The cron drain (v3 §8: "a Vercel Cron job reads with pgmq.read(queue, vt, qty) and archives on success") for the
-- 'architect' and 'verify' queues, and the enqueue of a verify job, as definer functions for the control plane
-- (the 'triggers' queue keeps its runtime-plane functions from 20261018000006).
create function private.queue_read(p_queue text, p_qty integer, p_vt integer)
returns table (msg_id bigint, read_ct integer, message jsonb)
language plpgsql security definer set search_path = ''
as $$
begin
  if p_queue not in ('architect', 'verify') then
    raise exception 'queue % is not drained here', p_queue using errcode = '22023';
  end if;
  return query select r.msg_id, r.read_ct, r.message from pgmq.read(p_queue, p_vt, p_qty) r;
end
$$;

create function private.queue_archive(p_queue text, p_msg_id bigint)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if p_queue not in ('architect', 'verify') then
    raise exception 'queue % is not drained here', p_queue using errcode = '22023';
  end if;
  return pgmq.archive(p_queue, p_msg_id);
end
$$;

create function private.verify_send(p_job jsonb)
returns bigint
language sql security definer set search_path = ''
as $$ select pgmq.send('verify', p_job) $$;

revoke execute on function private.queue_read(text, integer, integer), private.queue_archive(text, bigint), private.verify_send(jsonb)
  from public, anon, authenticated;
grant execute on function private.queue_read(text, integer, integer), private.queue_archive(text, bigint), private.verify_send(jsonb)
  to archable_control;

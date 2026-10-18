-- supabase/migrations/20261018000011_architect_enqueue.sql (P4.D2.7)
-- The owner's "Draft it" enqueues a draft job on pgmq 'architect' (v3 §8); the queue is reached only through definer
-- functions, as 'triggers' is (20261018000006). The cron drain (read, archive) comes with P4.D2.8.
create function private.architect_send(p_job jsonb)
returns bigint
language sql security definer set search_path = ''
as $$ select pgmq.send('architect', p_job) $$;

revoke execute on function private.architect_send(jsonb) from public, anon, authenticated;
grant execute on function private.architect_send(jsonb) to archable_control;

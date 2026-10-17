-- supabase/migrations/20261018000001_plane_roles_extensions.sql
-- The records trigger (security invoker) validates attrs with extensions.jsonb_matches_schema. On Supabase the
-- extensions schema grants usage only to Supabase's own roles, so a write by either plane role failed with
-- "permission denied for schema extensions". The plan's test cluster stubbed pg_jsonschema (plan §9.3).
grant usage on schema extensions to archable_runtime, archable_control;
grant execute on function extensions.jsonb_matches_schema(json, jsonb) to archable_runtime, archable_control;

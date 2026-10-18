-- supabase/migrations/20261018000007_approvals_approver_cascade.sql (PROGRESS.md Q6)
-- approvals.approver referenced memberships with no delete action (v3 §8), so deleting a tenant failed with 23503
-- as soon as it had an approval: the tenant cascade reaches memberships, and the approvals' reference blocked it.
-- Approvals already cascade from change_requests; now they also go with their approver's membership.
-- Memberships are revoked (revoked_at), not deleted, during a tenant's life, so the approval trail stays intact
-- until the tenant itself is deleted.
alter table public.approvals
  drop constraint approvals_approver_fkey,
  add constraint approvals_approver_fkey foreign key (approver) references public.memberships (id) on delete cascade;

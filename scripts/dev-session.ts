// scripts/dev-session.ts: a Supabase session for a seeded member, for the plan §5.8 check.
//   pnpm -s tsx scripts/dev-session.ts --tenant marani --role owner      → prints an access token, nothing else
// The member gets an auth user with the synthetic address tg-<id>@users.archable.run (plan §10.1 item 5), linked to
// the membership on first use; each run sets a fresh random password and signs in with it.
import { createHash, randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import { controlDb, withTenant } from '../apps/api/src/db';

const { values } = parseArgs({ options: { tenant: { type: 'string', default: 'marani' }, role: { type: 'string', default: 'owner' } } });
const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anon = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !service || !anon) throw new Error('set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY');

// The same tenant id the seed derives from the slug (scripts/seed-marani.ts).
const h = createHash('sha256').update(`archable:tenant:${values.tenant}`).digest('hex');
const tenantId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;

const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });

const member = await withTenant(controlDb, tenantId, async (tx) => {
  const [m] = await tx<{ id: string; user_id: string | null; tg_user_id: string | null }[]>`
    select id, user_id, tg_user_id from public.memberships
     where tenant_id = ${tenantId} and role = ${values.role!} and revoked_at is null order by created_at limit 1`;
  if (!m) throw new Error(`no live ${values.role} membership on ${values.tenant}`);
  if (m.user_id) return { ...m, user_id: m.user_id };
  const email = `tg-${m.tg_user_id ?? m.id}@users.archable.run`;
  const created = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (created.error) throw created.error;
  await tx`update public.memberships set user_id = ${created.data.user.id} where tenant_id = ${tenantId} and id = ${m.id}`;
  return { ...m, user_id: created.data.user.id };
});

const user = await admin.auth.admin.getUserById(member.user_id);
if (user.error || !user.data.user.email) throw user.error ?? new Error('member has no email');
const password = randomBytes(24).toString('base64url');
const set = await admin.auth.admin.updateUserById(member.user_id, { password });
if (set.error) throw set.error;
const signedIn = await createClient(url, anon, { auth: { persistSession: false } }).auth.signInWithPassword({ email: user.data.user.email, password });
if (signedIn.error) throw signedIn.error;
process.stdout.write(signedIn.data.session.access_token + '\n');
await controlDb.end();

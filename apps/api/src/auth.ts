// apps/api/src/auth.ts: shell callers carry a Supabase session JWT; the API checks it and resolves the membership.
// The tenant is the origin's, never a body field (plan §5.6).
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { runtimeDb } from './db';
import { routeOrigin, type OriginRoute } from './http/origin';
import type { Member } from './routes/turn';

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;   // created on first use: importing the app needs no env
const keys = () => (jwks ??= createRemoteJWKSet(new URL(process.env.SUPABASE_JWKS_URL!)));   // https://<ref>.supabase.co/auth/v1/.well-known/jwks.json

const memberships = {
  // private.member_for: one live membership on one live tenant, or nothing (migration 20261018000002).
  async byUserAndOrigin(userId: string, r: OriginRoute): Promise<Member | null> {
    const rows = await runtimeDb<{ tenant_id: string; membership_id: string; role: Member['role'] }[]>`
      select tenant_id, membership_id, role
        from private.member_for(${userId}, ${r.kind === 'tenant' ? r.slug : null}, ${r.kind === 'custom' ? r.host : null})`;
    const m = rows[0];
    return m ? { tenantId: m.tenant_id, membershipId: m.membership_id, role: m.role } : null;
  },
};

export async function memberFromJwt(authorization: string | undefined, origin: string | undefined, requestUrl?: string | URL): Promise<Member | null> {
  if (!authorization?.startsWith('Bearer ')) return null;
  const r = routeOrigin(origin, requestUrl);                    // the tenant is the origin or an approved frontend query hint
  if (!r) return null;
  try {
    const { payload } = await jwtVerify(authorization.slice(7), keys(), { audience: 'authenticated' });
    return await memberships.byUserAndOrigin(String(payload.sub), r);   // null if no live membership on that tenant
  } catch {
    return null;
  }
}

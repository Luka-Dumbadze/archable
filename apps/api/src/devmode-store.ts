// apps/api/src/devmode-store.ts: DevDeps (plan §8.3) on the runtime plane, in the member's tenant context.
// activeBundle reads the tenant's active bundle (graph, tool contracts, agents); Elva's playground link comes from
// ELVA_PLAYGROUND_URL (null when unset); lastDrift is 'unknown' until CI reports contract drift (PROGRESS.md P5.D2.2).
import type postgres from 'postgres';
import type { Bundle } from '@archable/compiler';
import { withTenant } from './db';
import type { DevDeps } from './routes/devmode';

export function createDevStore(runtime: postgres.Sql, o: { memberFromJwt: DevDeps['memberFromJwt']; playgroundBase?: string }): DevDeps {
  return {
    memberFromJwt: o.memberFromJwt,
    activeBundle: (tenantId) => withTenant(runtime, tenantId, async (tx) => {
      const [s] = await tx<{ git_sha: string; bundle: Pick<Bundle, 'a2a' | 'tools' | 'agents'> }[]>`
        select s.git_sha, s.bundle from public.specs s join public.tenants t on t.id = s.tenant_id and t.active_digest = s.digest
         where s.tenant_id = ${tenantId}`;
      if (!s) throw new Error(`tenant ${tenantId} has no active bundle`);
      return { git_sha: s.git_sha, a2a: s.bundle.a2a, tools: s.bundle.tools, agents: s.bundle.agents };
    }),
    withTenant: (tenantId, fn) => withTenant(runtime, tenantId, fn),
    elva: {
      playgroundUrl: (slug, tool) => (o.playgroundBase
        ? `${o.playgroundBase.replace(/\/$/, '')}?tenant=${encodeURIComponent(slug)}&tool=${encodeURIComponent(tool)}` : null),
      lastDrift: async () => 'unknown',
    },
    slugOf: (tenantId) => withTenant(runtime, tenantId, async (tx) =>
      (await tx<{ slug: string }[]>`select slug from public.tenants where id = ${tenantId}`)[0]!.slug),
  };
}

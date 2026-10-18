// apps/api/src/routes/devmode.ts: Developer Mode data. Owner and developer only.
// The graph and the contracts come from the bundle (no network); statistics come from tool_calls.
import { Hono } from 'hono';
import type { A2AGraph, EdgeCall, EdgeDetail, EdgeStats, JsonSchema } from '@archable/contracts';
import type { Member } from './turn';
import type { Tx } from '../db';

export interface DevDeps {
  memberFromJwt(authorization: string | undefined, origin: string | undefined, requestUrl?: string | URL): Promise<Member | null>;
  activeBundle(tenantId: string): Promise<{
    git_sha: string; a2a: A2AGraph;
    tools: Record<string, { description: string; input: JsonSchema; output: JsonSchema | null; operation_id: string }>;
    agents: Record<string, { app: string }>;
  }>;
  withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  elva: { playgroundUrl(tenantSlug: string, tool: string): string | null; lastDrift(tenantId: string): Promise<'in_sync' | 'drift' | 'unknown'> };
  slugOf(tenantId: string): Promise<string>;
}

export function devRoutes(d: DevDeps) {
  const app = new Hono<{ Variables: { member: Member } }>();
  app.use('/v1/dev/*', async (c, next) => {
    const m = await d.memberFromJwt(c.req.header('authorization'), c.req.header('origin'), c.req.url);
    if (!m || m.role === 'staff') return c.json({ error: 'forbidden' }, 403);
    c.set('member', m);
    await next();
  });

  app.get('/v1/dev/a2a', async (c) => c.json((await d.activeBundle(c.get('member').tenantId)).a2a));

  app.get('/v1/dev/a2a/edges/:id{.+}', async (c) => {
    const { tenantId } = c.get('member');
    const b = await d.activeBundle(tenantId);
    const edge = b.a2a.edges.find((e) => e.id === c.req.param('id'));
    if (!edge) return c.json({ error: 'not_found' }, 404);
    // Calls on this edge: the tool it carries, made by the agents of the source app (or by the trigger).
    const tool = edge.kind === 'event' ? null : edge.via;
    const callers = edge.kind === 'event'
      ? [`trigger:${edge.via}`]
      : Object.entries(b.agents).filter(([, a]) => `app:${a.app}` === edge.from).map(([id]) => `agent:${id}`);
    const toolName = tool ?? '%';
    const { stats, recent } = await d.withTenant(tenantId, async (tx) => {
      const [s] = await tx<EdgeStats[]>`
        select '24h' as window, count(*)::int as calls,
               count(*) filter (where decision = 'deny')::int as denied,
               count(*) filter (where status = 'error')::int as errors,
               percentile_cont(0.5) within group (order by latency_ms)::int as p50_ms,
               percentile_cont(0.95) within group (order by latency_ms)::int as p95_ms
          from public.tool_calls
         where tool like ${toolName} and caller = any(${callers}) and created_at > now() - interval '24 hours'`;
      const r = await tx<EdgeCall[]>`
        select id, created_at as at, caller, tool, decision, status, latency_ms, policies, turn_id
          from public.tool_calls
         where tool like ${toolName} and caller = any(${callers})
         order by created_at desc limit 20`;
      return { stats: s!, recent: [...r] };
    });
    const contract = tool && b.tools[tool] ? { tool, ...b.tools[tool], git_sha: b.git_sha } : null;
    const slug = await d.slugOf(tenantId);
    return c.json<EdgeDetail>({
      edge, contract, stats, recent,
      elva: { playground_url: tool ? d.elva.playgroundUrl(slug, tool) : null, sync: await d.elva.lastDrift(tenantId) },
    });
  });
  return app;
}

// apps/api/src/routes/manifest.ts: GET /v1/manifest. The shell boots from this one call (§2.4 of v3).
import { Hono } from 'hono';
import type { Env, Manifest } from '@archable/contracts';
import { routeOrigin } from '../http/origin';

export interface ManifestDeps {
  bySlug(slug: string, env: Env): Promise<Manifest | null>;   // env 'pr-N' → change_requests.bundle_digest
  byCustomDomain(host: string): Promise<Manifest | null>;
}

export function manifestRoutes(d: ManifestDeps) {
  const app = new Hono();
  app.get('/v1/manifest', async (c) => {
    const r = routeOrigin(c.req.header('origin'), c.req.url);
    if (!r) return c.json({ error: 'unknown_origin' }, 400);
    const m = r.kind === 'tenant' ? await d.bySlug(r.slug, r.env) : await d.byCustomDomain(r.host);
    if (!m) return c.json({ error: 'not_found' }, 404);
    c.header('Cache-Control', 'public, max-age=0, s-maxage=5');
    c.header('Vary', 'Origin');
    return c.json(m);
  });
  return app;
}

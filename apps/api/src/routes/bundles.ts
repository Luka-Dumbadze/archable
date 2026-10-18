// apps/api/src/routes/bundles.ts: GET /v1/bundles/:digest/ui (v3 §2.4 step 3). A member's shell reads its tenant's UI
// projection by digest; a digest never changes meaning, so the answer is cached forever, privately (per member).
// The tenant is the request origin's (memberFromJwt), so a digest of another tenant is a 404.
import type { UiProjection } from '@archable/contracts';
import { Hono } from 'hono';
import type { Member } from './turn';

export interface BundleDeps {
  memberFromJwt(authorization: string | undefined, origin: string | undefined, requestUrl?: string | URL): Promise<Member | null>;
  uiProjection(tenantId: string, digest: string): Promise<UiProjection | null>;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export function bundleRoutes(d: BundleDeps) {
  const routes = new Hono();
  routes.get('/v1/bundles/:digest/ui', async (c) => {
    const digest = c.req.param('digest');
    if (!DIGEST.test(digest)) return c.json({ error: 'bad_digest' }, 400);
    const m = await d.memberFromJwt(c.req.header('authorization'), c.req.header('origin'), c.req.url);
    if (!m) return c.json({ error: 'unauthorized' }, 401);
    const p = await d.uiProjection(m.tenantId, digest);
    if (!p) return c.json({ error: 'not_found' }, 404);
    c.header('Cache-Control', 'private, max-age=31536000, immutable');
    c.header('Vary', 'Origin, Authorization');
    return c.json(p);
  });
  return routes;
}

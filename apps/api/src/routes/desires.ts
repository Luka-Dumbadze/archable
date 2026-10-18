// apps/api/src/routes/desires.ts: the Desires Feed for Developer Mode (DEV-1's proposal, PROGRESS.md Q9 (4)).
//   GET  /v1/dev/desires                                → DesireView[]
//   POST /v1/dev/desires/:id/chats/:chapterId/unlink    → the recomputed DesireView
// Owner and developer only, as the rest of /v1/dev/*. Members have no update grant on desire_chapters, so unlinking
// is this route: it sets unlinked_at, records the caller's role in linked_by and recomputes the card's numbers.
import type { DesireView } from '@archable/contracts';
import { Hono, type MiddlewareHandler } from 'hono';
import type { Member } from './turn';

export interface DesireDeps {
  memberFromJwt(authorization: string | undefined, origin: string | undefined): Promise<Member | null>;
  list(tenantId: string): Promise<DesireView[]>;
  unlink(tenantId: string, desireId: string, chapterId: string, role: 'owner' | 'developer'): Promise<DesireView | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function desireRoutes(d: DesireDeps) {
  type E = { Variables: { member: Member } };
  const app = new Hono<E>();
  const auth: MiddlewareHandler<E> = async (c, next) => {
    const m = await d.memberFromJwt(c.req.header('authorization'), c.req.header('origin'));
    if (!m || m.role === 'staff') return c.json({ error: 'forbidden' }, 403);
    c.set('member', m);
    await next();
  };
  app.use('/v1/dev/desires', auth);
  app.use('/v1/dev/desires/*', auth);

  app.get('/v1/dev/desires', async (c) => c.json(await d.list(c.get('member').tenantId)));

  app.post('/v1/dev/desires/:id/chats/:chapterId/unlink', async (c) => {
    const { id, chapterId } = c.req.param();
    if (!UUID.test(id) || !UUID.test(chapterId)) return c.json({ error: 'bad_request' }, 400);
    const m = c.get('member');
    const v = await d.unlink(m.tenantId, id, chapterId, m.role === 'owner' ? 'owner' : 'developer');
    return v ? c.json(v) : c.json({ error: 'not_found' }, 404);
  });
  return app;
}

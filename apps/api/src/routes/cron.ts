// apps/api/src/routes/cron.ts: GET /v1/cron/drain, the Vercel Cron tick (vercel.json, every minute; v3 §8).
// Vercel sends `Authorization: Bearer $CRON_SECRET`; anything else is refused, so the drain can't be driven from outside.
import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { DrainReport } from '../queue-drain';

export interface CronDeps { secret: string | undefined; drain(): Promise<DrainReport> }

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function cronRoutes(d: CronDeps) {
  const routes = new Hono();
  routes.get('/v1/cron/drain', async (c) => {
    const auth = c.req.header('authorization') ?? '';
    if (!d.secret || !same(auth, `Bearer ${d.secret}`)) return c.json({ error: 'unauthorized' }, 401);
    return c.json(await d.drain());
  });
  return routes;
}

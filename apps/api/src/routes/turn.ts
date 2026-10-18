// apps/api/src/routes/turn.ts: POST /v1/turns, "Try as customer" for owner, developer and staff, and the
// fastest way to test the turn engine without a channel. Same engine, same Cedar, same pre-send checks.
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '@archable/contracts';
import type { HandleTurn } from '@archable/runtime';

export interface Member { tenantId: string; membershipId: string; role: 'owner' | 'developer' | 'staff' }

export interface TurnDeps {
  memberFromJwt(authorization: string | undefined, origin: string | undefined, requestUrl?: string | URL): Promise<Member | null>;   // Supabase JWT via JWKS
  handleTurn: HandleTurn;
  newTurnId(): string;
}

const Body = z.object({
  text: z.string().trim().min(1).max(2000),
  env: z.string().regex(/^(prod|pr-[0-9]{1,6})$/).default('prod'),
  thread: z.string().regex(/^[a-z0-9]{1,16}$/).default('main'),     // lets a tester keep several conversations
});

export function turnRoutes(d: TurnDeps) {
  const app = new Hono<{ Variables: { member: Member } }>();
  app.use('/v1/turns', async (c, next) => {
    const m = await d.memberFromJwt(c.req.header('authorization'), c.req.header('origin'), c.req.url);
    if (!m) return c.json({ error: 'unauthorized' }, 401);
    c.set('member', m);
    await next();
  });
  app.post('/v1/turns', async (c) => {
    const body = Body.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request', issues: body.error.issues }, 400);
    const m = c.get('member');
    const turnId = d.newTurnId();
    try {
      const r = await d.handleTurn({
        turnId, tenantId: m.tenantId, env: body.data.env as Env, channel: 'web',
        conversationKey: `try_${m.membershipId}_${body.data.thread}`, externalMessageId: null,
        text: body.data.text, customer: {}, reply: { kind: 'console' },
      });
      return c.json({ turn_id: r.turnId, reply: r.text, sent: r.allowed, trace: `/dev/turns/${r.turnId}` });
    } catch (e) {
      console.error(JSON.stringify({ event: 'turn.failed', turnId, error: String(e) }));
      return c.json({ error: 'turn_failed', turn_id: turnId }, 500);
    }
  });
  return app;
}

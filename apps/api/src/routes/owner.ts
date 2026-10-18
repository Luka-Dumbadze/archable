// apps/api/src/routes/owner.ts: Owner Mode on the web (plan §8.4). The owner's web chat is the same conversation as
// @ArchableBot: the reply and its buttons come from the same function as the bot's (governance-deps.ts), as data.
//   POST /v1/owner/messages {text}           → OwnerReply                  owner
//   POST /v1/owner/press {ref}               → OwnerReply (a post button)  owner; single-use ref, 410 when spent
//   GET  /v1/owner/changes/:id/rationale     → RationaleCard               owner, developer
// Approvals stay in Telegram (plan §8.4): the web never approves.
import type { OwnerReply, RationaleCard } from '@archable/contracts';
import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { Member } from './turn';

export interface OwnerDeps {
  memberFromJwt(authorization: string | undefined, origin: string | undefined): Promise<Member | null>;
  ownerMessageFor(member: { tenantId: string; membershipId: string }, text: string): Promise<OwnerReply>;
  ownerPressFor(member: { membershipId: string }, ref: string): Promise<OwnerReply | null>;
  rationaleCard(tenantId: string, changeRequestId: string): Promise<RationaleCard | null>;
}

const Message = z.object({ text: z.string().trim().min(1).max(2000) });
const Press = z.object({ ref: z.string().regex(/^[A-Za-z0-9_-]{22}$/) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function ownerRoutes(d: OwnerDeps) {
  type E = { Variables: { member: Member } };
  const app = new Hono<E>();
  const member = (roles: Member['role'][]): MiddlewareHandler<E> => async (c, next) => {
    const m = await d.memberFromJwt(c.req.header('authorization'), c.req.header('origin'));
    if (!m) return c.json({ error: 'unauthorized' }, 401);
    if (!roles.includes(m.role)) return c.json({ error: 'forbidden' }, 403);
    c.set('member', m);
    await next();
  };

  app.post('/v1/owner/messages', member(['owner']), async (c) => {
    const body = Message.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    return c.json(await d.ownerMessageFor(c.get('member'), body.data.text));
  });

  app.post('/v1/owner/press', member(['owner']), async (c) => {
    const body = Press.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const r = await d.ownerPressFor(c.get('member'), body.data.ref);
    return r ? c.json(r) : c.json({ text: 'This is no longer available.', buttons: [] } satisfies OwnerReply, 410);
  });

  app.get('/v1/owner/changes/:id/rationale', member(['owner', 'developer']), async (c) => {
    const id = c.req.param('id');
    if (!UUID.test(id)) return c.json({ error: 'bad_request' }, 400);
    const card = await d.rationaleCard(c.get('member').tenantId, id);
    return card ? c.json(card) : c.json({ error: 'not_found' }, 404);
  });
  return app;
}

// apps/api/src/routes/chat.ts: the web chat API behind <slug>.archable.run/chat and the embedded widget.
import { Hono } from 'hono';
import { z } from 'zod';
import type { ChatMessage, ChatSessionResponse, Env } from '@archable/contracts';
import type { HandleTurn } from '@archable/runtime';
import { hashSecret, isSecret, mintChatToken, newSecret, verifyChatToken, type ChatClaims } from '../channels/web/session';

export interface ChatDeps {
  key: Uint8Array;                                                         // WEB_SESSION_KEY
  openSession(slug: string, env: Env, secretHash: Buffer, origin: string | null):
    Promise<{ tenant_id: string; session_id: string; conversation_id: string } | null>;
  resumeSession(secretHash: Buffer):
    Promise<{ tenant_id: string; session_id: string; conversation_id: string; env: Env; slug: string } | null>;
  recentInbound(c: ChatClaims, seconds: number): Promise<number>;           // per-session rate limit
  existingReply(c: ChatClaims, clientMsgId: string): Promise<ChatMessage | null>;
  outboundAfter(c: ChatClaims, afterId: number): Promise<ChatMessage[]>;
  handleTurn: HandleTurn;
  newTurnId(): string;
}

const SLUG = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const OpenBody = z.object({
  tenant: z.string().regex(SLUG).refine((s) => !s.includes('--')),
  env: z.string().regex(/^(prod|pr-[0-9]{1,6})$/).default('prod'),
  secret: z.string().optional(),
  embed_origin: z.string().max(200).nullish(),
});
const MessageBody = z.object({
  text: z.string().trim().min(1).max(2000),
  client_msg_id: z.uuid(),                                                 // retried POSTs return the same reply
});
const TURN_WAIT_MS = 9_000;
const POLL_MS = 1_500;
const HOLD_MS = 25_000;

export function chatRoutes(d: ChatDeps) {
  const app = new Hono<{ Variables: { chat: ChatClaims } }>();

  app.post('/v1/chat/sessions', async (c) => {
    const body = OpenBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const { tenant, env, secret, embed_origin } = body.data;
    if (isSecret(secret)) {
      const s = await d.resumeSession(hashSecret(secret));
      if (s && s.slug === tenant && s.env === env) {
        const token = await mintChatToken({ tid: s.tenant_id, sid: s.session_id, cid: s.conversation_id, env: s.env }, d.key);
        return c.json<ChatSessionResponse>({ token, session_id: s.session_id });
      }
    }
    const fresh = newSecret();
    const s = await d.openSession(tenant, env as Env, hashSecret(fresh), embed_origin ?? null);
    if (!s) return c.json({ error: 'chat_unavailable' }, 404);              // unknown tenant, not live, or chat off
    const token = await mintChatToken({ tid: s.tenant_id, sid: s.session_id, cid: s.conversation_id, env: env as Env }, d.key);
    return c.json<ChatSessionResponse>({ token, secret: fresh, session_id: s.session_id }, 201);
  });

  app.use('/v1/chat/messages', async (c, next) => {
    const auth = c.req.header('authorization');
    const claims = auth?.startsWith('Bearer ') ? await verifyChatToken(auth.slice(7), d.key) : null;
    if (!claims) return c.json({ error: 'session_expired' }, 401);           // the iframe resumes with its secret
    c.set('chat', claims);
    await next();
  });

  app.post('/v1/chat/messages', async (c) => {
    const chat = c.get('chat');
    const body = MessageBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const seen = await d.existingReply(chat, body.data.client_msg_id);
    if (seen) return c.json({ messages: [seen] });
    if ((await d.recentInbound(chat, 60)) >= 12) return c.json({ error: 'slow_down' }, 429);

    const turnId = d.newTurnId();
    const turn = d.handleTurn({
      turnId, tenantId: chat.tid, env: chat.env, channel: 'web',
      conversationKey: `ws_${chat.sid}`, externalMessageId: body.data.client_msg_id,
      text: body.data.text, customer: { webSessionId: chat.sid }, reply: { kind: 'web', sessionId: chat.sid },
    });
    const timeout = new Promise<'pending'>((r) => setTimeout(() => r('pending'), TURN_WAIT_MS));
    const result = await Promise.race([turn, timeout]);
    if (result === 'pending') {
      turn.catch(() => {});                                   // finishes in the background; arrives via /events
      return c.json({ messages: [], pending: true }, 202);
    }
    if (result.paused) return c.json({ messages: [], pending: true }, 202);   // a person is answering
    return c.json({ messages: [{ id: result.outboundMessageId, author: 'agent', text: result.text, at: new Date().toISOString() }] });
  });

  // Long poll for staff replies and late agent replies. One request holds for at most 25 s.
  app.get('/v1/chat/events', async (c) => {
    const auth = c.req.header('authorization');
    const chat = auth?.startsWith('Bearer ') ? await verifyChatToken(auth.slice(7), d.key) : null;
    if (!chat) return c.json({ error: 'session_expired' }, 401);
    const after = Number(c.req.query('after') ?? '0');
    if (!Number.isSafeInteger(after) || after < 0) return c.json({ error: 'bad_request' }, 400);
    const until = Date.now() + HOLD_MS;
    while (Date.now() < until && !c.req.raw.signal.aborted) {
      const msgs = await d.outboundAfter(chat, after);
      if (msgs.length) return c.json({ messages: msgs });
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    return c.json({ messages: [] });
  });

  return app;
}

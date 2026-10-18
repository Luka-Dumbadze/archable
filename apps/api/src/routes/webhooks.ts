// apps/api/src/routes/webhooks.ts: Telegram ingress for tenant bots.
// One opaque path per bot: POST /v1/webhooks/telegram/b/:hookId. The path finds the channel row; the
// per-bot secret header authenticates the request; the bot token itself is never in a URL or a log line.
import { Hono } from 'hono';
import { timingSafeEqual, createHash } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import type { Update } from 'grammy/types';

export interface BotHook { tenant_id: string; channel_id: string; bot_id: number; hook_secret_hash: Buffer; token_secret: string }

export interface WebhookDeps {
  resolveBotHook(hookId: string): Promise<BotHook | null>;      // private.resolve_bot_hook
  firstSeen(botId: number, updateId: number): Promise<boolean>; // private.first_seen
  dispatchTenantUpdate(hook: BotHook, update: Update): Promise<void>;
  log(event: string, data: Record<string, unknown>): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest();

export function telegramWebhookRoutes(d: WebhookDeps) {
  const app = new Hono();
  app.post('/v1/webhooks/telegram/b/:hookId', async (c) => {
    const hookId = c.req.param('hookId');
    if (!UUID.test(hookId)) return c.body(null, 404);
    const hook = await d.resolveBotHook(hookId);
    if (!hook) return c.body(null, 404);                        // revoked or unknown: the bot was rebound
    const given = sha256(c.req.header('x-telegram-bot-api-secret-token') ?? '');
    if (!timingSafeEqual(given, hook.hook_secret_hash)) return c.body(null, 401);

    const update = (await c.req.json().catch(() => null)) as Update | null;
    if (!update || typeof update.update_id !== 'number') return c.body(null, 400);
    if (!(await d.firstSeen(hook.bot_id, update.update_id))) return c.body(null, 200);   // Telegram retry
    waitUntil(d.dispatchTenantUpdate(hook, update).catch((e: unknown) =>
      d.log('telegram.dispatch_failed', { tenant: hook.tenant_id, update: update.update_id, error: String(e) })));
    return c.body(null, 200);                                   // answer in < 1 s; the turn continues
  });
  return app;
}

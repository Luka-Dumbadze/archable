// apps/api/src/channels/mount.ts: the customer-channel routes of plan §6.4, mounted on the shared app by
// one call from app.ts so that file stays append-only. Deps: real where ready (live.ts), else fail-closed stand-ins.
import { createHash, timingSafeEqual } from 'node:crypto';
import { Bot, webhookCallback } from 'grammy';
import type { Hono } from 'hono';
import { tenantCors } from '../http/cors';
import { chatRoutes } from '../routes/chat';
import { telegramWebhookRoutes } from '../routes/webhooks';
import { widgetRoutes } from '../routes/widget';
import { registerArchableBot } from './telegram/archable-bot';
import { channelDeps } from './live';

// Verified tenants.custom_domain values, refreshed every 60 s (DEV-2), so CORS never queries per request.
export const customDomains = new Set<string>();
// Not `customDomains.has` as in the plan's excerpt: unbound, Set.prototype.has throws on the first custom origin.
const isCustomDomain = (host: string) => customDomains.has(host);
const sha256 = (s: string) => createHash('sha256').update(s).digest();

export function mountChannels(app: Hono, env: Record<string, string | undefined> = process.env) {
  const { chatDeps, webhookDeps, widgetDeps, archableBotDeps } = channelDeps(env);
  app.use('/v1/chat/*', tenantCors(isCustomDomain));
  app.use('/v1/manifest', tenantCors(isCustomDomain));
  app.use('/v1/turns', tenantCors(isCustomDomain));
  app.use('/v1/dev/*', tenantCors(isCustomDomain));
  app.route('/', chatRoutes(chatDeps));
  app.route('/', widgetRoutes(widgetDeps));
  app.route('/', telegramWebhookRoutes(webhookDeps));

  // @ArchableBot: only with its token and webhook secret; otherwise the endpoint says it isn't available.
  const token = env.ARCHABLE_BOT_TOKEN, secret = env.ARCHABLE_BOT_WEBHOOK_SECRET;
  if (token && secret) {
    const bot = new Bot(token);
    registerArchableBot(bot, archableBotDeps);
    const handle = webhookCallback(bot, 'hono', { secretToken: secret });
    const want = sha256(secret);
    // grammY calls getMe (bot.init) before it checks the secret, so unauthenticated requests stop here first.
    app.post('/v1/webhooks/telegram/archable', (c) =>
      timingSafeEqual(sha256(c.req.header('x-telegram-bot-api-secret-token') ?? ''), want) ? handle(c) : c.body(null, 401));
  } else {
    app.post('/v1/webhooks/telegram/archable', (c) => c.body(null, 503));
  }
}

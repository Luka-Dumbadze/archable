// apps/api/src/channels/telegram/delivery.ts: send.ts's deps on the live database (plan §6.2): the tenant bot's token
// from Vault at the last hop, the outbound message row, the channel pause and the fixed notices.
// Deliver's contract carries only the reply target, so each channel turn runs inside forTurn(): record() writes into
// that turn's conversation (copied from the turn's own inbound message), under the agent that served the channel.
import { AsyncLocalStorage } from 'node:async_hooks';
import { Api } from 'grammy';
import type { Bundle } from '@archable/compiler';
import { agentFor, createBundles, createEpochs, type HandleTurn, type Inbound, type InTenant, type ReplyTarget } from '@archable/runtime';
import { controlDb, runtimeDb, withTenant } from '../../db';
import type { BotHook } from '../../routes/webhooks';
import { createSender, type SendDeps } from './send';
import type { NoticeKind } from './tenant-bot';

export const TEXT_ONLY = 'Please type your message.';                // CLAUDE.md §3: voice, audio and photos get this

/** The SQL behind the deps. Every call runs in the tenant's RLS context. */
export interface DeliveryStore {
  channelSecret(tenantId: string, name: string): Promise<string | null>;
  turnInbound(tenantId: string, turnId: string): Promise<{ conversation_id: string; chapter_id: string | null; spec_digest: string } | null>;
  insertOutbound(tenantId: string, m: { conversationId: string; chapterId: string | null; turnId: string; author: string;
                                         body: string; specDigest: string; externalId: string | null }): Promise<number>;
  pauseChannel(tenantId: string, channelId: string): Promise<void>;
  bundle(tenantId: string, digest: string | null): Promise<Bundle>;    // null: the tenant's active prod bundle
}

export function sqlDeliveryStore(): DeliveryStore {
  const inTenant: InTenant = (tenantId, fn) => withTenant(runtimeDb, tenantId, fn);
  const bundles = createBundles(inTenant);
  const epochs = createEpochs(inTenant);
  return {
    async channelSecret(tenantId, name) {
      const [r] = await inTenant(tenantId, async (tx) => tx<{ token: string | null }[]>`select private.channel_secret(${name}) as token`);
      return r?.token ?? null;
    },
    async turnInbound(tenantId, turnId) {
      const [r] = await inTenant(tenantId, async (tx) => tx<{ conversation_id: string; chapter_id: string | null; spec_digest: string }[]>`
        select conversation_id, chapter_id, spec_digest from public.messages
         where tenant_id = ${tenantId} and turn_id = ${turnId} and direction = 'in' order by id desc limit 1`);
      return r ?? null;
    },
    async insertOutbound(tenantId, m) {
      const [r] = await inTenant(tenantId, async (tx) => tx<{ id: string }[]>`
        insert into public.messages (tenant_id, conversation_id, chapter_id, turn_id, direction, author, body, spec_digest, external_id)
        values (${tenantId}, ${m.conversationId}, ${m.chapterId}, ${m.turnId}, 'out', ${m.author}, ${m.body}, ${m.specDigest}, ${m.externalId})
        returning id`);
      return Number(r!.id);
    },
    async pauseChannel(tenantId, channelId) {
      await withTenant(controlDb, tenantId, async (tx) => {
        await tx`update public.channel_connections set status = 'paused', updated_at = now()
                  where tenant_id = ${tenantId} and id = ${channelId} and status = 'live'`;
      });
    },
    async bundle(tenantId, digest) {
      return bundles.load(tenantId, digest ?? (await epochs.pin(tenantId, 'prod')).digest);
    },
  };
}

type Scope = { tenantId: string; turnId: string | null; channel: Inbound['channel']; fallback: boolean };

export function createTelegramDelivery(o: {
  env: Record<string, string | undefined>;
  store?: DeliveryStore;
  apiFor?: SendDeps['apiFor'];
  log?: (event: string, data: Record<string, unknown>) => void;
}) {
  const store = o.store ?? sqlDeliveryStore();
  const log = o.log ?? ((event, data) => console.warn(JSON.stringify({ event, ...data })));
  const apiFor = o.apiFor ?? ((token: string) => new Api(token));
  const scope = new AsyncLocalStorage<Scope>();
  const platformToken = o.env.ARCHABLE_BOT_TOKEN;
  // A tenant bot whose token isn't in Vault sends with @ArchableBot's token instead, but only outside Vercel production
  // (local, preview, tests) or with TELEGRAM_TOKEN_FALLBACK=1 for a live test. In production it fails closed.
  const fallbackToken = platformToken && (o.env.VERCEL_ENV !== 'production' || o.env.TELEGRAM_TOKEN_FALLBACK === '1') ? platformToken : null;
  const current = (): Scope => {
    const s = scope.getStore();
    if (!s) throw new Error('Telegram delivery outside a channel turn (forTurn)');
    return s;
  };

  const sender = createSender({
    async channelToken(tokenSecret) {
      const s = current();
      const token = await store.channelSecret(s.tenantId, tokenSecret).catch((e: unknown) => { if (!fallbackToken) throw e; return null; });
      if (token) return token;
      if (!fallbackToken) throw new Error(`Vault has no secret ${tokenSecret}`);
      s.fallback = true;
      log('telegram.token_fallback', { tenantId: s.tenantId, secret: tokenSecret });   // the name only, never a token
      return fallbackToken;
    },
    archableApi: {                                                    // @ArchableBot: Business replies and suggestions
      sendMessage: (...a) => {
        if (!platformToken) throw new Error('ARCHABLE_BOT_TOKEN is not set');
        return apiFor(platformToken).sendMessage(...a);
      },
    },
    async record(_target, text, telegramMessageId) {
      const s = current();
      if (!s.turnId) throw new Error('a reply outside a turn has no conversation to record into');
      const turn = await store.turnInbound(s.tenantId, s.turnId);
      if (!turn) throw new Error(`no inbound message for turn ${s.turnId}`);
      const agent = agentFor(await store.bundle(s.tenantId, turn.spec_digest), { channel: s.channel });
      return store.insertOutbound(s.tenantId, {
        conversationId: turn.conversation_id, chapterId: turn.chapter_id, turnId: s.turnId, author: `agent:${agent}`,
        body: text, specDigest: turn.spec_digest, externalId: telegramMessageId === null ? null : String(telegramMessageId),
      });
    },
    async pauseChannel(channelId, reason) {
      const s = current();
      // A refusal of @ArchableBot's fallback token says nothing about the tenant's own bot: keep the channel live.
      if (s.fallback) return log('telegram.pause_skipped', { tenantId: s.tenantId, channelId, reason });
      await store.pauseChannel(s.tenantId, channelId);
      log('telegram.channel_paused', { tenantId: s.tenantId, channelId, reason });
    },
    async noticeText(tenantId, kind) {
      if (kind === 'text_only') return TEXT_ONLY;
      const b = await store.bundle(tenantId, null).catch(() => null);
      const greeting = b ? Object.values(b.channels).map((c) => c.public?.greeting).find((g) => g && Object.keys(g).length) : undefined;
      return greeting?.['en'] ?? (greeting ? Object.values(greeting)[0] : undefined) ?? 'Hi! How can I help?';
    },
    apiFor,
  });

  return {
    deliver: sender.deliver,
    /** A channel turn, with its tenant and turn beside the reply target for the deps above. */
    forTurn: (handleTurn: HandleTurn): HandleTurn => (inbound) =>
      scope.run({ tenantId: inbound.tenantId, turnId: inbound.turnId, channel: inbound.channel, fallback: false }, () => handleTurn(inbound)),
    /** Fixed answers outside a turn (tenant-bot.ts): the text-only reply and the /start greeting. */
    deliverNotice: (hook: BotHook, reply: ReplyTarget, kind: NoticeKind) =>
      scope.run({ tenantId: hook.tenant_id, turnId: null, channel: 'telegram', fallback: false }, () => sender.deliverNotice(hook, reply, kind)),
  };
}

let shared: ReturnType<typeof createTelegramDelivery> | null = null;
/** One live delivery per process: the turn engine's deliver (app.ts) and the channel entry points (live.ts). */
export const telegramDelivery = () => (shared ??= createTelegramDelivery({ env: process.env }));

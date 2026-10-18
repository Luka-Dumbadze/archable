// apps/api/src/channels/live.ts: the customer's web chat and bot turn entry points use the runtime engine;
// sessions, message polling and channel routing resolve through the SQL-backed channel store, and Telegram replies
// go out through send.ts (telegram/delivery.ts: Vault token, outbound row, channel pause).
// Governance actions remain on the fail-closed stand-ins in unwired.ts until their store is ready.
import { createBundles, type HandleTurn } from '@archable/runtime';
import { createChannelStore } from '../channel-store';
import { controlDb, runtimeDb, withTenant } from '../db';
import { createTurnEngine } from '../turn-wiring';
import type { ArchableBotDeps } from './telegram/archable-bot';
import { telegramDelivery } from './telegram/delivery';
import { tenantBotDispatcher } from './telegram/tenant-bot';
import type { WidgetDeps } from '../routes/widget';
import type { ChatDeps } from '../routes/chat';
import type { WebhookDeps } from '../routes/webhooks';
import { archableBotDeps as unwiredBot, chatDeps as unwiredChat, webhookDeps as unwiredWebhook, widgetDeps as unwiredWidget } from './unwired';

type Store = Pick<ReturnType<typeof createChannelStore>,
  'openSession' | 'resumeSession' | 'recentInbound' | 'existingReply' | 'outboundAfter' |
  'resolveBotHook' | 'firstSeen' | 'widgetConfig' | 'ownerTenants' | 'createLinkIntent' |
  'bindBusinessConnection' | 'resolveBusinessConnection' | 'bindTenantBot' | 'revokeChannel' | 'pauseAgent'>;

export function liveChannelDeps(store: Store = createChannelStore({
  runtime: runtimeDb, control: controlDb, bundles: createBundles((tenantId, fn) => withTenant(runtimeDb, tenantId, fn)),
}), handleTurn: HandleTurn = createTurnEngine({ deliver: telegramDelivery().deliver }), telegram = telegramDelivery()) {
  const turn = telegram.forTurn(handleTurn);                      // a Telegram reply records into its own turn
  const chatDeps: ChatDeps = {
    key: unwiredChat.key,
    openSession: (slug, env, secretHash, origin) => store.openSession(slug, env, secretHash, origin),
    resumeSession: (secretHash) => store.resumeSession(secretHash),
    recentInbound: (claims, seconds) => store.recentInbound(claims, seconds),
    existingReply: (claims, clientMsgId) => store.existingReply(claims, clientMsgId),
    outboundAfter: (claims, afterId) => store.outboundAfter(claims, afterId),
    handleTurn: turn,
    newTurnId: unwiredChat.newTurnId,
  };
  const widgetDeps: WidgetDeps = { widgetConfig: (slug) => store.widgetConfig(slug) };
  const webhookDeps: WebhookDeps = {
    ...unwiredWebhook,
    resolveBotHook: (hookId) => store.resolveBotHook(hookId),
    firstSeen: (botId, updateId) => store.firstSeen(botId, updateId),
    dispatchTenantUpdate: tenantBotDispatcher({ handleTurn: turn, deliverNotice: telegram.deliverNotice }),
  };
  const archableBotDeps: ArchableBotDeps = {
    ...unwiredBot,
    ownerTenants: (u) => store.ownerTenants(u),
    createLinkIntent: (t, m, u) => store.createLinkIntent(t, m, u),
    bindBusinessConnection: (a) => store.bindBusinessConnection(a),
    resolveBusinessConnection: (b, c) => store.resolveBusinessConnection(b, c),
    bindTenantBot: (a) => store.bindTenantBot(a),
    revokeChannel: (t, c) => store.revokeChannel(t, c),
    pauseAgent: (t, k, m) => store.pauseAgent(t, k, m),
    runTurn: turn,
  };
  return { chatDeps, webhookDeps, widgetDeps, archableBotDeps };
}

/** Real deps when both database planes are configured; otherwise every channel fails closed. */
export function channelDeps(env: Record<string, string | undefined>, live: () => ReturnType<typeof liveChannelDeps> = liveChannelDeps) {
  return env.DATABASE_URL_RUNTIME && env.DATABASE_URL_CONTROL
    ? live()
    : { chatDeps: unwiredChat, webhookDeps: unwiredWebhook, widgetDeps: unwiredWidget, archableBotDeps: unwiredBot };
}

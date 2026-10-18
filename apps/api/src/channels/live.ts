// apps/api/src/channels/live.ts: the customer's web chat and bot turn entry points use the runtime engine;
// sessions, message polling and channel routing resolve through the SQL-backed channel store, and Telegram replies
// go out through send.ts (telegram/delivery.ts: Vault token, outbound row, channel pause). @ArchableBot's approvals,
// owner intake and Undo use DEV-2's governance deps when Jev is configured (governanceBotDeps below).
import { githubApp, type CardEditor as GovernanceCardEditor } from '@archable/governance';
import { createBundles, typesafeDecisionModel, type HandleTurn } from '@archable/runtime';
import { Api } from 'grammy';
import { sharedArchitect } from '../architect-wiring';
import { createGovernanceDeps } from '../governance-deps';
import { createCardEditor } from './telegram/cards';
import { createChannelStore } from '../channel-store';
import { controlDb, runtimeDb, withTenant } from '../db';
import { createLanguageModels, createTurnEngine } from '../turn-wiring';
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
    ...governanceBotDeps(),                           // approvals, owner intake, Undo (DEV-2, P4.D2.7), when Jev is configured
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

// DEV-2 (authorized by RM, 18 Oct, for the Telegram live test): @ArchableBot's governance deps from governance-deps.ts,
// with DEV-1's card editor (channels/telegram/cards.ts) for settle's Live card and a push's supersede. Without Jev
// (TYPESAFE_API_KEY) the stand-ins stay. settle merges only with the GitHub App configured.
function governanceBotDeps(env: Record<string, string | undefined> = process.env): Partial<ArchableBotDeps> {
  if (!env.TYPESAFE_API_KEY) return {};
  const log = (event: string, data: Record<string, unknown>) => console.log(JSON.stringify({ event, ...data }));
  const secret = env.GITHUB_WEBHOOK_SECRET ?? env.GITHUB_SECRET;
  const github = env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && secret
    ? githubApp({ GITHUB_APP_ID: env.GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET: secret }) : null;
  const editor = env.ARCHABLE_BOT_TOKEN ? createCardEditor({ api: new Api(env.ARCHABLE_BOT_TOKEN), log }) : null;
  const cards: GovernanceCardEditor | undefined = editor ? {
    reflect: async () => {},                          // the card keeps its text until it goes live or is superseded
    live: async (c, osName, title, undoRef) => { await editor.live(c, osName, title, undoRef); },
    supersede: async (c, title) => { await editor.supersede(c, title); },
  } : undefined;
  const architect = github ? sharedArchitect({ app: github, log }) : null;
  const g = createGovernanceDeps({
    control: controlDb, app: github, log, ...(cards ? { cards } : {}), ...(architect ? { kick: architect.kick } : {}),
    intake: { jev: typesafeDecisionModel({ apiKey: env.TYPESAFE_API_KEY }), lane: { model: createLanguageModels()(env.OWNER_INTAKE_MODEL ?? 'openai/gpt-6-luna') } },
  });
  return { consume: g.consume, beginTyped: g.beginTyped, completeTyped: g.completeTyped, approvalSummary: g.approvalSummary,
           settle: g.settle, rationaleFor: g.rationaleFor, ownerMessage: g.ownerMessage, ownerPress: g.ownerPress, undo: g.undo };
}

/** Real deps when both database planes are configured; otherwise every channel fails closed. */
export function channelDeps(env: Record<string, string | undefined>, live: () => ReturnType<typeof liveChannelDeps> = liveChannelDeps) {
  return env.DATABASE_URL_RUNTIME && env.DATABASE_URL_CONTROL
    ? live()
    : { chatDeps: unwiredChat, webhookDeps: unwiredWebhook, widgetDeps: unwiredWidget, archableBotDeps: unwiredBot };
}

// apps/api/src/channels/live.ts: the customer channels' real deps, where DEV-2's side is ready end to end
// (channel-store.ts, P3.D2.1). A flow is wired only when it works end to end; the rest stays on the fail-closed
// stand-ins in unwired.ts:
//   wired:   widget config; @ArchableBot channel binding (owner tenants, link intents, Business connect, tenant bot
//            token, revoke, pause agent); tenant-bot dispatch (the turn engine with send.ts's deliver)
//   waiting: web chat
import { githubApp, type CardEditor as GovernanceCardEditor } from '@archable/governance';
import { createBundles, typesafeDecisionModel } from '@archable/runtime';
import { Api } from 'grammy';
import { sharedArchitect, telegramCardSender } from '../architect-wiring';
import { createGovernanceDeps } from '../governance-deps';
import { createLanguageModels, createTurnEngine } from '../turn-wiring';
import { createCardEditor } from './telegram/cards';
import { createSender } from './telegram/send';
import { tenantBotDispatcher } from './telegram/tenant-bot';
import { createChannelStore } from '../channel-store';
import { controlDb, runtimeDb, withTenant } from '../db';
import type { ArchableBotDeps } from './telegram/archable-bot';
import type { WebhookDeps } from '../routes/webhooks';
import type { WidgetDeps } from '../routes/widget';
import { archableBotDeps as unwiredBot, chatDeps, webhookDeps, widgetDeps as unwiredWidget } from './unwired';

type Store = Pick<ReturnType<typeof createChannelStore>,
  'widgetConfig' | 'ownerTenants' | 'createLinkIntent' | 'bindBusinessConnection' | 'resolveBusinessConnection' |
  'bindTenantBot' | 'revokeChannel' | 'pauseAgent' | 'resolveBotHook' | 'firstSeen' | 'channelToken' |
  'recordTelegramReply' | 'pauseChannel' | 'noticeText'>;

export function liveChannelDeps(store: Store = createChannelStore({
  runtime: runtimeDb, control: controlDb, bundles: createBundles((tenantId, fn) => withTenant(runtimeDb, tenantId, fn)),
})) {
  const widgetDeps: WidgetDeps = { widgetConfig: (slug) => store.widgetConfig(slug) };
  const webhookDeps = tenantBotWebhookDeps(store);
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
  };
  return { chatDeps, webhookDeps, widgetDeps, archableBotDeps };
}

// DEV-2 (authorized by RM, 18 Oct, for the demo): a tenant bot's update → the turn engine → send.ts's deliver.
// ReplyTarget names the channel and the token's Vault name, not the tenant, so dispatch remembers which tenant each
// belongs to; delivery happens in the same process, inside the turn the dispatch started.
function tenantBotWebhookDeps(store: Store): WebhookDeps {
  const log = (event: string, data: Record<string, unknown>) => console.log(JSON.stringify({ event, ...data }));
  const tenantOf = new Map<string, string>();               // channel id or token secret name → tenant id
  const tenant = (key: string) => {
    const t = tenantOf.get(key);
    if (!t) throw new Error('delivery outside a dispatched turn');
    return t;
  };
  const sender = createSender({
    channelToken: (name) => store.channelToken(tenant(name), name),
    archableApi: new Api(process.env.ARCHABLE_BOT_TOKEN ?? ''),        // Business replies; tenant bots use their own token
    record: (t, text, id) => t.kind === 'telegram'
      ? store.recordTelegramReply(tenant(t.channelId), t.chatId, text, id)
      : Promise.reject(new Error(`no recorder for ${t.kind} replies`)),
    pauseChannel: (channelId, reason) => store.pauseChannel(tenant(channelId), channelId, reason),
    noticeText: (tenantId, kind) => store.noticeText(tenantId, kind),
  });
  const dispatch = tenantBotDispatcher({ handleTurn: createTurnEngine({ deliver: sender.deliver }), deliverNotice: sender.deliverNotice });
  return {
    resolveBotHook: (hookId) => store.resolveBotHook(hookId),
    firstSeen: (botId, updateId) => store.firstSeen(botId, updateId),
    dispatchTenantUpdate: async (hook, update) => {
      tenantOf.set(hook.channel_id, hook.tenant_id);
      tenantOf.set(hook.token_secret, hook.tenant_id);
      await dispatch(hook, update);
    },
    log,
  };
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
  const architect = github ? sharedArchitect({ app: github, log, ...(env.ARCHABLE_BOT_TOKEN ? { send: telegramCardSender(env.ARCHABLE_BOT_TOKEN) } : {}) }) : null;
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
    : { chatDeps, webhookDeps, widgetDeps: unwiredWidget, archableBotDeps: unwiredBot };
}

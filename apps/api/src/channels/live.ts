// apps/api/src/channels/live.ts: the customer channels' real deps, where DEV-2's side is ready end to end
// (channel-store.ts, P3.D2.1). A flow is wired only when it works end to end; the rest stays on the fail-closed
// stand-ins in unwired.ts:
//   wired:   widget config; @ArchableBot channel binding (owner tenants, link intents, Business connect, tenant bot
//            token, revoke, pause agent)
//   waiting: web chat and tenant-bot dispatch (handleTurn needs a deliver that records outbound messages and reads
//            the bot token from Vault); approvals, owner intake and Undo (governance, P4.D2.7)
import { githubApp, type CardEditor as GovernanceCardEditor } from '@archable/governance';
import { createBundles, typesafeDecisionModel } from '@archable/runtime';
import { Api } from 'grammy';
import { sharedArchitect } from '../architect-wiring';
import { createGovernanceDeps } from '../governance-deps';
import { createLanguageModels } from '../turn-wiring';
import { createCardEditor } from './telegram/cards';
import { createChannelStore } from '../channel-store';
import { controlDb, runtimeDb, withTenant } from '../db';
import type { ArchableBotDeps } from './telegram/archable-bot';
import type { WidgetDeps } from '../routes/widget';
import { archableBotDeps as unwiredBot, chatDeps, webhookDeps, widgetDeps as unwiredWidget } from './unwired';

type Store = Pick<ReturnType<typeof createChannelStore>,
  'widgetConfig' | 'ownerTenants' | 'createLinkIntent' | 'bindBusinessConnection' | 'resolveBusinessConnection' |
  'bindTenantBot' | 'revokeChannel' | 'pauseAgent'>;

export function liveChannelDeps(store: Store = createChannelStore({
  runtime: runtimeDb, control: controlDb, bundles: createBundles((tenantId, fn) => withTenant(runtimeDb, tenantId, fn)),
})) {
  const widgetDeps: WidgetDeps = { widgetConfig: (slug) => store.widgetConfig(slug) };
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
    : { chatDeps, webhookDeps, widgetDeps: unwiredWidget, archableBotDeps: unwiredBot };
}

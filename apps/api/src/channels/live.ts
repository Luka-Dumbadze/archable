// apps/api/src/channels/live.ts: the customer channels' real deps, where DEV-2's side is ready end to end
// (channel-store.ts, P3.D2.1). A flow is wired only when it works end to end; the rest stays on the fail-closed
// stand-ins in unwired.ts:
//   wired:   widget config; @ArchableBot channel binding (owner tenants, link intents, Business connect, tenant bot
//            token, revoke, pause agent)
//   waiting: web chat and tenant-bot dispatch (handleTurn needs a deliver that records outbound messages and reads
//            the bot token from Vault); approvals, owner intake and Undo (governance, P4.D2.7)
import { createBundles } from '@archable/runtime';
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

/** Real deps when both database planes are configured; otherwise every channel fails closed. */
export function channelDeps(env: Record<string, string | undefined>, live: () => ReturnType<typeof liveChannelDeps> = liveChannelDeps) {
  return env.DATABASE_URL_RUNTIME && env.DATABASE_URL_CONTROL
    ? live()
    : { chatDeps, webhookDeps, widgetDeps: unwiredWidget, archableBotDeps: unwiredBot };
}

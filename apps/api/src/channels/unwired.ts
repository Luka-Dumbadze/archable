// apps/api/src/channels/unwired.ts: STAND-IN deps for the customer channels until DEV-2's db wrappers land
// (P3.D2.1). Every function fails closed: no session opens, no hook resolves, no widget config exists, and
// @ArchableBot binds and approves nothing. Deployed as-is, the routes answer 404/401 and never hold data.
// DEV-2 replaces these exports with SQL-backed implementations of the same interfaces.
import { randomBytes, randomUUID } from 'node:crypto';
import type { ChatDeps } from '../routes/chat';
import type { WidgetDeps } from '../routes/widget';
import type { WebhookDeps } from '../routes/webhooks';
import type { ArchableBotDeps } from './telegram/archable-bot';

const notWired = (what: string) => () => Promise.reject(new Error(`${what} is not wired yet (P3.D2.1)`));
const log = (event: string, data: Record<string, unknown>) => console.log(JSON.stringify({ event, ...data }));

export const chatDeps: ChatDeps = {
  // WEB_SESSION_KEY is 32+ random bytes, base64url. Without it no token minted here verifies anywhere else.
  key: process.env.WEB_SESSION_KEY ? Buffer.from(process.env.WEB_SESSION_KEY, 'base64url') : randomBytes(32),
  openSession: async () => null,                       // → 404 chat_unavailable
  resumeSession: async () => null,
  recentInbound: async () => 0,
  existingReply: async () => null,
  outboundAfter: async () => [],
  handleTurn: notWired('handleTurn'),
  newTurnId: randomUUID,
};

export const widgetDeps: WidgetDeps = {
  widgetConfig: async () => null,                      // → 404: the loader draws nothing
};

export const webhookDeps: WebhookDeps = {
  resolveBotHook: async () => null,                    // → 404 for every tenant-bot hook
  firstSeen: async () => false,
  dispatchTenantUpdate: async () => {},
  log,
};

export const archableBotDeps: ArchableBotDeps = {
  ownerTenants: async () => [],                        // nobody is an owner: binding and intents are refused
  createLinkIntent: async () => {},
  bindBusinessConnection: async () => ({ outcome: 'ignored', tenant_id: null }),
  resolveBusinessConnection: async () => null,
  bindTenantBot: notWired('bindTenantBot'),
  revokeChannel: async () => {},
  pauseAgent: async () => {},
  runTurn: notWired('runTurn'),
  consume: async () => ({ outcome: 'unknown', change_request_id: null }),
  beginTyped: async () => ({ outcome: 'unknown', approval_id: null }),
  completeTyped: async () => ({ outcome: 'no_challenge', change_request_id: null }),
  approvalSummary: async () => '',
  settle: async () => {},
  rationaleFor: async () => null,
  ownerMessage: async () => ({ text: 'Archable is still being set up. Please try again later.', buttons: [] }),
  ownerPress: async () => null,
  publicApiOrigin: process.env.PUBLIC_API_ORIGIN ?? 'https://api.archable.run',
  newTurnId: randomUUID,
};

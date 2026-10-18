// apps/api/src/channel-store.ts: the database side of DEV-1's channel routes (TEAM_PROTOCOL.md §2, "The seams"):
// ChatDeps, WebhookDeps and the channel functions of ArchableBotDeps, over the plan §4.2 SQL. Each wrapper runs as
// the role the migration grants it to: webhook ingress and chat as archable_runtime, binding and owner flows as
// archable_control. Return shapes match the interfaces in routes/chat.ts, routes/webhooks.ts and archable-bot.ts.
import type { ChatMessage, Env } from '@archable/contracts';
import type postgres from 'postgres';
import { withTenant } from './db';

export interface ChatClaims { tid: string; sid: string; cid: string; env: Env }   // channels/web/session.ts
export interface BotHook { tenant_id: string; channel_id: string; bot_id: number; hook_secret_hash: Buffer; token_secret: string }

type BusinessOutcome = 'bound' | 'updated' | 'disconnected' | 'no_intent' | 'not_owner' | 'ignored';

// messages.author → the chat API's three authors ('agent:cellar_master' → 'agent', 'staff:<id>' → 'staff').
const authorOf = (a: string): ChatMessage['author'] => (a === 'customer' ? 'customer' : a.startsWith('staff') ? 'staff' : 'agent');
const message = (m: { id: string; author: string; body: string | null; created_at: Date }): ChatMessage =>
  ({ id: Number(m.id), author: authorOf(m.author), text: m.body ?? '', at: m.created_at.toISOString() });

export function createChannelStore(db: { runtime: postgres.Sql; control: postgres.Sql }) {
  const { runtime, control } = db;

  return {
    // ── ChatDeps ──
    async openSession(slug: string, env: Env, secretHash: Buffer, origin: string | null) {
      const [s] = await runtime<{ tenant_id: string; session_id: string; conversation_id: string }[]>`
        select tenant_id, session_id, conversation_id from public.open_web_session(${slug}, ${env}, ${secretHash}, ${origin})`;
      return s ?? null;                                         // null: unknown tenant or web chat off
    },

    async resumeSession(secretHash: Buffer) {
      const [s] = await runtime<{ tenant_id: string; session_id: string; conversation_id: string; env: Env }[]>`
        select tenant_id, session_id, conversation_id, env from public.resume_web_session(${secretHash})`;
      if (!s) return null;
      const [t] = await withTenant(runtime, s.tenant_id, (tx) => tx<{ slug: string }[]>`select slug from public.tenants where id = ${s.tenant_id}`);
      return t ? { ...s, slug: t.slug } : null;
    },

    recentInbound(c: ChatClaims, seconds: number): Promise<number> {
      return withTenant(runtime, c.tid, async (tx) => {
        const [r] = await tx<{ n: number }[]>`
          select count(*)::int as n from public.messages
           where tenant_id = ${c.tid} and conversation_id = ${c.cid} and direction = 'in'
             and created_at > now() - make_interval(secs => ${seconds})`;
        return r!.n;
      });
    },

    /** The reply already given to this client_msg_id, for a retried POST. */
    existingReply(c: ChatClaims, clientMsgId: string): Promise<ChatMessage | null> {
      return withTenant(runtime, c.tid, async (tx) => {
        const [m] = await tx<{ id: string; author: string; body: string | null; created_at: Date }[]>`
          select o.id, o.author, o.body, o.created_at
            from public.messages i
            join public.messages o on o.tenant_id = i.tenant_id and o.conversation_id = i.conversation_id
                                  and o.turn_id = i.turn_id and o.direction = 'out'
           where i.tenant_id = ${c.tid} and i.conversation_id = ${c.cid} and i.direction = 'in' and i.external_id = ${clientMsgId}
           order by o.id limit 1`;
        return m ? message(m) : null;
      });
    },

    outboundAfter(c: ChatClaims, afterId: number): Promise<ChatMessage[]> {
      return withTenant(runtime, c.tid, async (tx) => {
        const rows = await tx<{ id: string; author: string; body: string | null; created_at: Date }[]>`
          select id, author, body, created_at from public.messages
           where tenant_id = ${c.tid} and conversation_id = ${c.cid} and direction = 'out' and id > ${afterId}
           order by id limit 50`;
        return rows.map(message);
      });
    },

    // ── WebhookDeps ──
    async resolveBotHook(hookId: string): Promise<BotHook | null> {
      const [h] = await runtime<{ tenant_id: string; channel_id: string; bot_id: string; hook_secret_hash: Buffer; token_secret: string }[]>`
        select tenant_id, channel_id, bot_id, hook_secret_hash, token_secret from private.resolve_bot_hook(${hookId})`;
      return h ? { ...h, bot_id: Number(h.bot_id) } : null;
    },

    async firstSeen(botId: number, updateId: number): Promise<boolean> {
      const [r] = await runtime<{ first: boolean }[]>`select private.first_seen(${botId}, ${updateId}) as first`;
      return r!.first;
    },

    // ── ArchableBotDeps: channels ──
    async ownerTenants(tgUserId: number) {
      return control<{ tenant_id: string; slug: string; os_name: string; membership_id: string }[]>`
        select tenant_id, slug, os_name, membership_id from private.owner_tenants(${tgUserId})`;
    },

    createLinkIntent(tenantId: string, membershipId: string, tgUserId: number): Promise<void> {
      return withTenant(control, tenantId, async (tx) => {
        await tx`insert into public.channel_link_intents (tenant_id, membership_id, tg_user_id)
                 values (${tenantId}, ${membershipId}, ${tgUserId})`;
      });
    },

    async bindBusinessConnection(a: { viaBot: number; connectionId: string; user: number; userChat: number; canReply: boolean; enabled: boolean }) {
      const [r] = await control<{ outcome: BusinessOutcome; tenant_id: string | null }[]>`
        select outcome, tenant_id from public.bind_business_connection(${a.viaBot}, ${a.connectionId}, ${a.user}, ${a.userChat}, ${a.canReply}, ${a.enabled})`;
      return r!;
    },

    async resolveBusinessConnection(viaBot: number, connectionId: string) {
      const [r] = await runtime<{ tenant_id: string; channel_id: string; business_user_id: string; can_reply: boolean }[]>`
        select tenant_id, channel_id, business_user_id, can_reply from private.resolve_business_connection(${viaBot}, ${connectionId})`;
      return r ? { ...r, business_user_id: Number(r.business_user_id) } : null;
    },

    /** Owner pasted a BotFather token: Vault + hook binding in one definer call; 42501 if not the owner. */
    async bindTenantBot(a: { tenantId: string; membershipId: string; botId: number; username: string; token: string; hookId: string; secretHash: Buffer }): Promise<string> {
      const [r] = await control<{ id: string }[]>`
        select public.bind_tenant_bot(${a.tenantId}, ${a.membershipId}, ${a.botId}, ${a.username}, ${a.token}, ${a.hookId}, ${a.secretHash}) as id`;
      return r!.id;
    },

    revokeChannel(tenantId: string, channelId: string): Promise<void> {
      return withTenant(control, tenantId, async (tx) => {
        await tx`update public.channel_connections set status = 'revoked', updated_at = now()
                  where tenant_id = ${tenantId} and id = ${channelId} and status <> 'revoked'`;
      });
    },

    /** A person answered in this conversation (owner in Business, staff from the inbox): the agent stays quiet. */
    pauseAgent(tenantId: string, conversationKey: string, minutes: number): Promise<void> {
      return withTenant(runtime, tenantId, async (tx) => {
        await tx`update public.conversations set agent_paused_until = now() + make_interval(mins => ${minutes})
                  where tenant_id = ${tenantId} and external_id = ${conversationKey}`;
      });
    },
  };
}

export type ChannelStore = ReturnType<typeof createChannelStore>;

// packages/runtime/src/store.ts: the turn engine's facts in Postgres (v3 §8): conversations, messages, chapters,
// failures. Every call runs as archable_runtime inside the tenant's RLS context.
import type { Env } from '@archable/contracts';
import type { ConversationRow } from './context';
import type { InTenant } from './db';
import type { Msg } from './decisions';
import type { Inbound, TurnResult } from './types';

export interface Conversation extends ConversationRow { tail: Msg[] }

export function createStore(inTenant: InTenant) {
  return {
    /** (tenant, env, channel, external_id) is unique; the last six messages come back for routing. */
    upsertConversation(inbound: Inbound): Promise<Conversation> {
      return inTenant(inbound.tenantId, async (tx) => {
        const [c] = await tx<ConversationRow[]>`
          insert into public.conversations (tenant_id, env, channel, external_id, last_message_at)
          values (${inbound.tenantId}, ${inbound.env}, ${inbound.channel}, ${inbound.conversationKey}, now())
          on conflict (tenant_id, env, channel, external_id) do update set last_message_at = now()
          returning id, customer_id, active_chapter, agent_paused_until`;
        const recent = await tx<{ author: string; body: string }[]>`
          select author, body from public.messages
           where tenant_id = ${inbound.tenantId} and conversation_id = ${c!.id} and body is not null
           order by id desc limit 6`;
        return { ...c!, tail: recent.reverse() };
      });
    },

    /** Null when this external message id was already stored: a channel retry, answered with the first reply. */
    insertInbound(conv: Conversation, inbound: Inbound, digest: string): Promise<number | null> {
      return inTenant(inbound.tenantId, async (tx) => {
        const rows = await tx<{ id: string }[]>`
          insert into public.messages (tenant_id, conversation_id, chapter_id, turn_id, direction, author, body, spec_digest, external_id)
          values (${inbound.tenantId}, ${conv.id}, ${conv.active_chapter}, ${inbound.turnId}, 'in', 'customer', ${inbound.text}, ${digest},
                  ${inbound.externalMessageId})
          on conflict (tenant_id, conversation_id, direction, external_id) do nothing
          returning id`;
        return rows[0] ? Number(rows[0].id) : null;
      });
    },

    /** The reply the first delivery of this message got; empty while that turn is still running. */
    replyFor(conv: Conversation, inbound: Inbound): Promise<TurnResult> {
      return inTenant(inbound.tenantId, async (tx) => {
        const [prior] = await tx<{ turn_id: string }[]>`
          select turn_id from public.messages
           where tenant_id = ${inbound.tenantId} and conversation_id = ${conv.id} and direction = 'in' and external_id = ${inbound.externalMessageId}`;
        const [out] = prior ? await tx<{ id: string; body: string | null }[]>`
          select id, body from public.messages
           where tenant_id = ${inbound.tenantId} and conversation_id = ${conv.id} and direction = 'out' and turn_id = ${prior.turn_id}
           order by id limit 1` : [];
        const [sent] = prior ? await tx<{ allowed: boolean | null }[]>`
          select bool_and(verdict = 'pass') as allowed from public.decision_log
           where tenant_id = ${inbound.tenantId} and turn_id = ${prior.turn_id} and stage = 'pre_send'` : [];
        return { turnId: prior?.turn_id ?? inbound.turnId, text: out?.body ?? '', allowed: Boolean(out && sent?.allowed),
                 outboundMessageId: out ? Number(out.id) : 0, paused: false };
      });
    },

    /** The conversation's open chapter, opened with the route's intent when there is none. */
    ensureChapter(tenantId: string, env: Env, conv: Conversation, kind: string, customerId: string | null): Promise<string> {
      return inTenant(tenantId, async (tx) => {
        if (conv.active_chapter) return conv.active_chapter;
        const [ch] = await tx<{ id: string }[]>`
          insert into public.chapters (tenant_id, env, customer_id, kind) values (${tenantId}, ${env}, ${customerId}, ${kind}) returning id`;
        await tx`update public.conversations set active_chapter = ${ch!.id} where tenant_id = ${tenantId} and id = ${conv.id}`;
        await tx`update public.messages set chapter_id = ${ch!.id}
                  where tenant_id = ${tenantId} and conversation_id = ${conv.id} and chapter_id is null and direction = 'in'`;
        return ch!.id;
      });
    },

    /** A reply recorded in the conversation (web and console, where the HTTP response is the delivery). */
    insertOutbound(tenantId: string, conv: Conversation, chapterId: string | null, turnId: string, author: string, text: string, digest: string): Promise<number> {
      return inTenant(tenantId, async (tx) => {
        const [m] = await tx<{ id: string }[]>`
          insert into public.messages (tenant_id, conversation_id, chapter_id, turn_id, direction, author, body, spec_digest)
          values (${tenantId}, ${conv.id}, ${chapterId}, ${turnId}, 'out', ${author}, ${text}, ${digest}) returning id`;
        return Number(m!.id);
      });
    },

    captureFailure(tenantId: string, turnId: string, kind: 'grounding_block' | 'customer_frustration' | 'deadline', severity: number, payload: unknown): Promise<void> {
      return inTenant(tenantId, async (tx) => {
        await tx`insert into public.failures (tenant_id, turn_id, kind, severity, payload)
                 values (${tenantId}, ${turnId}, ${kind}, ${severity}, ${tx.json(payload as never)})`;
      });
    },
  };
}

export type Store = ReturnType<typeof createStore>;

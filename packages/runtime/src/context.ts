// packages/runtime/src/context.ts: what the dialogue model sees besides the system prompt: the conversation tail,
// the active chapter and the customer (v3 §6 agents.*.context; v3 §7.1, loaded in parallel with routing).
// Read only. Opening a chapter needs the route's intent, so handleTurn does it (plan §5.4).
import type { InTenant } from './db';
import type { Pin } from './epochs';

export interface ConversationRow {
  id: string;
  customer_id: string | null;
  active_chapter: string | null;
  agent_paused_until: Date | null;
}

export interface TurnContext {
  chapter: { id: string; kind: string; status: string; summary: string | null } | null;
  customer: { id: string; attrs: Record<string, unknown> } | null;
  messages: { role: 'user' | 'assistant'; content: string }[];   // oldest first
  locale: string;
}

export interface ContextOptions {
  tail: number;                                               // agents.*.context.conversation_tail
  locale: string;                                             // metadata.locale.primary until the customer's is known
}

export function createContext(inTenant: InTenant) {
  return {
    load(tenantId: string, pin: Pin, conv: ConversationRow, o: ContextOptions): Promise<TurnContext> {
      return inTenant(tenantId, async (tx) => {
        const chapters = conv.active_chapter
          ? await tx<{ id: string; kind: string; status: string; summary: string | null }[]>`
              select id, kind, status, summary from public.chapters where tenant_id = ${tenantId} and id = ${conv.active_chapter}`
          : [];
        const customers = conv.customer_id
          ? await tx<{ id: string; attrs: Record<string, unknown> }[]>`
              select id, attrs from public.records
               where tenant_id = ${tenantId} and id = ${conv.customer_id} and env = ${pin.env}`
          : [];
        const recent = await tx<{ direction: 'in' | 'out'; body: string | null }[]>`
          select direction, body from public.messages
           where tenant_id = ${tenantId} and conversation_id = ${conv.id} and body is not null
           order by id desc limit ${o.tail}`;
        return {
          chapter: chapters[0] ?? null,
          customer: customers[0] ?? null,
          messages: recent.reverse().map((m) => ({ role: m.direction === 'in' ? 'user' as const : 'assistant' as const, content: m.body! })),
          locale: o.locale,
        };
      });
    },
  };
}

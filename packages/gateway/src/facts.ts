// packages/gateway/src/facts.ts: facts.forPolicy (plan §5.5 [a]). Builds a tool call's input and Cedar context from
// the compiled facts plan: input defaults, the records the action's policies read (by id or by key, with derived
// <ref>_<key> attributes) and approvals. A record that can't be found stays absent, so Cedar denies the call.
import type { ActionFacts, Bundle } from '@archable/compiler';
import type { Env } from '@archable/contracts';
import type { InTenant, Tx } from './db';

// The object a chat is with. On chat channels, inputs holding its key (the phone) come from the customer linked
// to the chat, never from the model; on the web the customer types it (plan §5.5 [a]).
const CHAT_PERSON = 'customer';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CallSession {
  channel: 'telegram' | 'telegram_business' | 'web' | 'console';
  linkedCustomerId: string | null;                           // conversations.customer_id
}

export interface PolicyFacts { input: Record<string, unknown>; context: Record<string, unknown> }

type Row = { id: string; natural_key: string | null; attrs: Record<string, unknown> };
type ObjectSchema = { properties?: Record<string, { default?: unknown; 'x-archable'?: { ref?: { object: string; by?: string } } }> };

const NO_FACTS: ActionFacts = { objects: [], defaults: {}, keyInputs: {}, quote: false };

async function record(tx: Tx, tenantId: string, env: Env, object: string, by: 'id' | 'key', value: unknown): Promise<Row | null> {
  if (typeof value !== 'string' || (by === 'id' && !UUID.test(value))) return null;
  const rows = by === 'id'
    ? await tx<Row[]>`select id, natural_key, attrs from public.records
                       where tenant_id = ${tenantId} and env = ${env} and entity_type = ${object} and id = ${value}`
    : await tx<Row[]>`select id, natural_key, attrs from public.records
                       where tenant_id = ${tenantId} and env = ${env} and entity_type = ${object} and natural_key = ${value}`;
  return rows[0] ?? null;
}

export function createFacts(inTenant: InTenant) {
  return {
    forPolicy(tenantId: string, env: Env, bundle: Bundle, tool: string, input: Record<string, unknown>, s: CallSession): Promise<PolicyFacts> {
      const plan = bundle.policies.facts[tool] ?? NO_FACTS;
      return inTenant(tenantId, async (tx) => {
        const filled: Record<string, unknown> = { ...plan.defaults, ...input };

        const personInputs = Object.entries(plan.keyInputs).filter(([, o]) => o === CHAT_PERSON).map(([name]) => name);
        if (personInputs.length && s.channel !== 'web' && s.linkedCustomerId) {
          const person = await record(tx, tenantId, env, CHAT_PERSON, 'id', s.linkedCustomerId);
          if (person?.natural_key) for (const name of personInputs) filled[name] = person.natural_key;
        }

        const context: Record<string, unknown> = { approvals: [] };
        for (const load of plan.objects) {
          const r = await record(tx, tenantId, env, load.object, load.by, filled[load.via]);
          if (!r) continue;                                    // absent: Cedar rejects the request
          const props = (bundle.objects[load.object]?.schema as ObjectSchema | undefined)?.properties ?? {};
          // Records store what was written; the spec's field defaults (age_verified: false) apply when a field is absent,
          // or the context would miss a required attribute and Cedar would reject every call for that record.
          const defaults = Object.fromEntries(Object.entries(props).filter(([, p]) => p.default !== undefined).map(([k, p]) => [k, p.default]));
          const fact: Record<string, unknown> = { ...defaults, ...r.attrs };
          for (const [field, p] of Object.entries(props)) {
            const ref = p['x-archable']?.ref;
            if (!ref) continue;
            if (ref.by) fact[`${field}_${ref.by}`] = r.attrs[field];
            else {
              const targetKey = bundle.objects[ref.object]?.key;
              const target = targetKey ? await record(tx, tenantId, env, ref.object, 'id', r.attrs[field]) : null;
              if (targetKey && target?.natural_key) fact[`${field}_${targetKey}`] = target.natural_key;
            }
          }
          context[load.attr] = fact;
        }
        return { input: filled, context };
      });
    },
  };
}

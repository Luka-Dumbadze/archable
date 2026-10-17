// packages/runtime/src/drafts.ts: the reply under review and the evidence it is judged against (v3 §7.1, plan §5.4).
// The digest binds pre-send signals to this exact text. Evidence shows money as the customer reads it ("35.00 GEL"):
// Jev scored a correct "35.00 GEL" reply grounded 0.20 against `price: 3500` (PROGRESS.md Q5).
import { createHash } from 'node:crypto';
import type { Bundle } from '@archable/compiler';
import type { JSONValue } from 'ai';
import type { Draft } from './decisions';

type Schema = { type?: string; properties?: Record<string, Schema>; items?: Schema; 'x-archable'?: { semantics?: string; currency?: string; scale?: number } };

export const textDigest = (text: string) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

/** Money fields (x-archable semantics money, integer minor units) rendered with their currency; the rest unchanged. */
export function displayMoney(value: unknown, schema: Schema | null | undefined): JSONValue {
  const x = schema?.['x-archable'];
  if (x?.semantics === 'money' && typeof value === 'number') {
    const scale = x.scale ?? 2;
    return `${(value / 10 ** scale).toFixed(scale)} ${x.currency ?? ''}`.trim();
  }
  if (Array.isArray(value)) return value.map((v) => displayMoney(v, schema?.items));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, displayMoney(v, schema?.properties?.[k])])) as JSONValue;
  }
  return (value ?? null) as JSONValue;
}

export interface Evidence { tool: string; input: Record<string, unknown>; output: Record<string, unknown> }

export function draftOf(bundle: Bundle, text: string, evidence: Evidence[], turn: { tenantId: string; turnId: string; inReplyTo: string }): Draft {
  return {
    tenantId: turn.tenantId,
    turnId: turn.turnId,
    text,
    digest: textDigest(text),
    inReplyTo: turn.inReplyTo,
    evidence: evidence.map((e) => {
      const c = bundle.tools[e.tool];
      return { tool: e.tool, input: displayMoney(e.input, c?.input as Schema), output: displayMoney(e.output, c?.output as Schema | null) };
    }),
  };
}

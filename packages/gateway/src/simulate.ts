// packages/gateway/src/simulate.ts: previews and CONNECTIONS_MODE=simulate share one path (plan §5.5 [b]).
// Outputs are valid against the tool's output schema; tools without one (delivery.dispatch) get a fake job id
// and an ETA 45 minutes ahead. Nothing leaves the system.
import { randomUUID } from 'node:crypto';
import type { Bundle } from '@archable/compiler';
import type { JsonSchema } from '@archable/contracts';

const ETA_MS = 45 * 60_000;

function fake(s: JsonSchema, now: Date): unknown {
  if (Array.isArray(s.enum)) return s.enum[0];
  switch (s.type) {
    case 'integer': case 'number': return typeof s.minimum === 'number' ? s.minimum : 0;
    case 'boolean': return false;
    case 'array': return [];
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, JsonSchema>;
      return Object.fromEntries(((s.required ?? []) as string[]).map((k) => [k, fake(props[k] ?? {}, now)]));
    }
    default: return s.format === 'date-time' ? new Date(now.getTime() + ETA_MS).toISOString() : `sim_${randomUUID()}`;
  }
}

export function simulate(c: Bundle['tools'][string], _input: Record<string, unknown>, now = new Date()): Record<string, unknown> {
  if (!c.output) return { simulated: true, job_id: `sim_${randomUUID()}`, eta: new Date(now.getTime() + ETA_MS).toISOString() };
  return fake(c.output, now) as Record<string, unknown>;
}

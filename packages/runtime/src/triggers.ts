// packages/runtime/src/triggers.ts: drains pgmq 'triggers' (migration 20261018000006) and calls each spec trigger's
// tool through the Tool Gateway as Trigger::"<id>", so Cedar decides and tool_calls logs caller 'trigger:<id>' (plan §5.5).
// At-least-once: a job is archived after its call returns; the idempotency key (trigger, record, version) makes a
// redelivered job a duplicate instead of a second notification. A tool error leaves the job for retry, up to MAX_READS.
import { randomUUID } from 'node:crypto';
import type { Bundle } from '@archable/compiler';
import type { Env } from '@archable/contracts';
import { toolGateway, type CallResult, type GatewayDeps } from '@archable/gateway';

export interface TriggerJob {
  tenant_id: string; env: Env; digest: string; trigger: string; call: string; object: string;
  record_id: string; value: string; version: number;
}
export interface TriggerQueue {
  read(qty: number): Promise<{ msg_id: number; read_ct: number; message: TriggerJob }[]>;
  archive(msgId: number): Promise<void>;
}
export interface DrainResult { trigger: string; record_id: string; value: string; outcome: string; result?: CallResult }

const MAX_READS = 5;

/** The input of `tool` that takes a record of `object` (its schema's x-archable ref): customer.notify → job. */
function inputFor(bundle: Bundle, tool: string, object: string): string | null {
  const props = (bundle.tools[tool]?.input.properties ?? {}) as Record<string, { 'x-archable'?: { ref?: { object?: string } } }>;
  return Object.entries(props).find(([, p]) => p['x-archable']?.ref?.object === object)?.[0] ?? null;
}

export function createTriggerDrain(d: { queue: TriggerQueue; bundles: { load(tenantId: string, digest: string): Promise<Bundle> }; gateway: GatewayDeps; log?: (line: object) => void }) {
  const log = d.log ?? ((l: object) => console.log(JSON.stringify(l)));
  return async function drain(qty = 10): Promise<DrainResult[]> {
    const out: DrainResult[] = [];
    for (const { msg_id, read_ct, message: j } of await d.queue.read(qty)) {
      const done = async (outcome: string, result?: CallResult) => {
        await d.queue.archive(msg_id);
        out.push({ trigger: j.trigger, record_id: j.record_id, value: j.value, outcome, ...(result ? { result } : {}) });
        log({ event: 'trigger.done', tenant: j.tenant_id, trigger: j.trigger, outcome });
      };
      try {
        const bundle = await d.bundles.load(j.tenant_id, j.digest);
        const input = inputFor(bundle, j.call, j.object);
        if (!input) { await done('no_input_for_record'); continue; }
        const gw = toolGateway({
          tenantId: j.tenant_id, turnId: randomUUID(), pin: { env: j.env, digest: j.digest }, bundle,
          principal: { type: 'Trigger', id: j.trigger }, chapterId: null, session: { channel: 'console', linkedCustomerId: null },
        }, d.gateway);
        const result = await gw.call(j.call, { [input]: j.record_id }, { idempotencyKey: `${j.trigger}:${j.record_id}:${j.version}` });
        if ('error' in result && read_ct < MAX_READS) {                // tool_unavailable: retry when the job reappears
          out.push({ trigger: j.trigger, record_id: j.record_id, value: j.value, outcome: 'retry', result });
          continue;
        }
        await done('duplicate' in result ? 'duplicate' : 'denied' in result ? 'denied' : 'error' in result ? 'gave_up' : 'called', result);
      } catch (e) {
        if (read_ct >= MAX_READS) await done(`gave_up: ${String(e)}`);
        else out.push({ trigger: j.trigger, record_id: j.record_id, value: j.value, outcome: `retry: ${String(e)}` });
      }
    }
    return out;
  };
}

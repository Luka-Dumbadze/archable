import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, type Bundle } from '@archable/compiler';
import type { GatewayDeps, InTenant, Tx } from '@archable/gateway';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { createTriggerDrain, type TriggerJob } from './triggers';

const ROOT = fileURLToPath(new URL('../../../fixtures/marani', import.meta.url));
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const files = Object.fromEntries(walk(ROOT).map((p) => [relative(ROOT, p).split(sep).join('/'), readFileSync(p, 'utf8')]));
const marani: Bundle = compile({ files }, YAML.parse(files['archable.lock']!)).bundle;

const job = (o: Partial<TriggerJob> = {}): TriggerJob => ({ tenant_id: 't', env: 'prod', digest: 'sha256:x', trigger: 'notify_on_job_status',
  call: 'customer.notify', object: 'delivery_job', record_id: 'aaaaaaaa-0000-4000-8000-000000000009', value: 'picked_up', version: 2, ...o });

function harness(o: { keys?: Set<string>; notify?: () => Promise<Record<string, unknown>>; readCt?: number } = {}) {
  const keys = o.keys ?? new Set<string>();
  const archived: number[] = [];
  const calls: Record<string, unknown>[] = [];
  const inTenant: InTenant = async (_t, fn) => {
    const tx = ((strings: TemplateStringsArray, ...v: unknown[]) => {
      const sql = strings.join('$');
      if (sql.includes('idempotency_key = $') && sql.startsWith('select')) return Promise.resolve(keys.has(String(v.at(-1))) ? [{ 1: 1 }] : []);
      if (sql.startsWith('insert into public.tool_calls')) { if (v.at(-1)) keys.add(String(v.at(-1))); }
      return Promise.resolve([]);
    }) as unknown as Tx;
    (tx as unknown as { json: (x: unknown) => unknown }).json = (x) => x;
    return fn(tx);
  };
  const gateway: GatewayDeps = {
    inTenant, facts: { forPolicy: async (_t, _e, _b, _tool, input) => ({ input, context: { approvals: [] } }) },
    quotes: { price: async () => ({}) }, connectionsMode: 'live',
    executors: { 'customer.notify': async (input) => { calls.push(input); return o.notify ? o.notify() : { sent: true }; } },
  };
  const queue = (jobs: TriggerJob[]) => ({
    read: async () => jobs.map((message, i) => ({ msg_id: i + 1, read_ct: o.readCt ?? 1, message })),
    archive: async (id: number) => { archived.push(id); },
  });
  return { keys, archived, calls, gateway, queue };
}

describe('trigger drain', () => {
  it('calls the trigger’s tool with the record on the input that refers to its object, then archives', async () => {
    const h = harness();
    const drain = createTriggerDrain({ queue: h.queue([job()]), bundles: { load: async () => marani }, gateway: h.gateway, log: () => {} });
    expect((await drain())[0]).toMatchObject({ trigger: 'notify_on_job_status', outcome: 'called' });
    expect(h.calls).toEqual([{ job: 'aaaaaaaa-0000-4000-8000-000000000009' }]);
    expect(h.archived).toEqual([1]);
    expect([...h.keys]).toEqual(['notify_on_job_status:aaaaaaaa-0000-4000-8000-000000000009:2']);
  });

  it('a redelivered job (same trigger, record and version) is a duplicate: no second notification', async () => {
    const h = harness();
    const drain = createTriggerDrain({ queue: h.queue([job(), job()]), bundles: { load: async () => marani }, gateway: h.gateway, log: () => {} });
    expect((await drain()).map((r) => r.outcome)).toEqual(['called', 'duplicate']);
    expect(h.calls).toHaveLength(1);
    expect(h.archived).toEqual([1, 2]);
  });

  it('a later transition of the same record (a new version) notifies again', async () => {
    const h = harness();
    const drain = createTriggerDrain({ queue: h.queue([job(), job({ version: 3, value: 'delivered' })]), bundles: { load: async () => marani }, gateway: h.gateway, log: () => {} });
    expect((await drain()).map((r) => r.outcome)).toEqual(['called', 'called']);
  });

  it('a failing tool leaves the job for retry, and gives up after five reads', async () => {
    const failing = () => Promise.reject(new Error('courier down'));
    const early = harness({ notify: failing as never });
    expect((await createTriggerDrain({ queue: early.queue([job()]), bundles: { load: async () => marani }, gateway: early.gateway, log: () => {} })())[0]!.outcome).toBe('retry');
    expect(early.archived).toEqual([]);
    const late = harness({ notify: failing as never, readCt: 5 });
    expect((await createTriggerDrain({ queue: late.queue([job()]), bundles: { load: async () => marani }, gateway: late.gateway, log: () => {} })())[0]!.outcome).toBe('gave_up');
    expect(late.archived).toEqual([1]);
  });
});

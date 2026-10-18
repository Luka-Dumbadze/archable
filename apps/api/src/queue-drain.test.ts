import { describe, expect, it, vi } from 'vitest';

const handled: string[] = [];
let behaviour: Record<string, () => Promise<{ outcome: string; retry?: boolean }>> = {};
vi.mock('@archable/architect', () => ({
  runDraftJob: (_d: unknown, j: { desire_id: string }) => { handled.push(`draft:${j.desire_id}`); return behaviour[j.desire_id]!(); },
  runVerifyJob: (_d: unknown, j: { change_request_id: string }) => { handled.push(`verify:${j.change_request_id}`); return Promise.resolve({ outcome: 'verified' }); },
}));
const { createQueueDrainer, MAX_READS } = await import('./queue-drain');

// A control plane standing in for pgmq: queue_read hands out the queued jobs once each; queue_archive records.
function fakeControl(queues: Record<string, { msg_id: string; read_ct: number; message: Record<string, unknown> }[]>) {
  const archived: string[] = [];
  const sql = (strings: TemplateStringsArray, ...v: unknown[]) => {
    const q = strings.join('?');
    if (q.includes('queue_read')) return Promise.resolve(queues[v[0] as string]!.splice(0, 1));
    if (q.includes('queue_archive')) { archived.push(`${v[0]}:${v[1]}`); return Promise.resolve([]); }
    throw new Error(`unexpected ${q}`);
  };
  return { sql: sql as never, archived };
}
const job = (id: string, reads = 1, kind = 'draft') => ({ msg_id: id, read_ct: reads, message: { kind, tenant_id: 't', desire_id: id, change_request_id: id } });

describe('queue drain (P4.D2.8)', () => {
  it('handles every job and archives it; verify jobs too; triggers drained', async () => {
    handled.length = 0;
    behaviour = { a: async () => ({ outcome: 'opened' }), b: async () => ({ outcome: 'skipped' }) };
    const c = fakeControl({ architect: [job('a'), job('b')], verify: [job('v', 1, 'verify')] });
    const drain = createQueueDrainer({ control: c.sql, author: {} as never, triggers: async () => [1, 2], log: () => {} });
    const r = await drain();
    expect(handled).toEqual(['draft:a', 'draft:b', 'verify:v']);
    expect(c.archived).toEqual(['architect:a', 'architect:b', 'verify:v']);
    expect(r.triggers).toBe(2);
  });

  it('a retry (base moved) is not archived: it comes back after the visibility timeout', async () => {
    behaviour = { a: async () => ({ outcome: 'base_moved', retry: true }) };
    const c = fakeControl({ architect: [job('a')], verify: [] });
    await createQueueDrainer({ control: c.sql, author: {} as never, log: () => {} })();
    expect(c.archived).toEqual([]);
  });

  it(`a failing job stays for the next tick, and is archived as dead after ${MAX_READS} reads`, async () => {
    behaviour = { a: async () => { throw new Error('GitHub 502'); }, b: async () => ({ outcome: 'opened' }) };
    const early = fakeControl({ architect: [job('a', 1), job('b')], verify: [] });
    const r1 = await createQueueDrainer({ control: early.sql, author: {} as never, log: () => {} })();
    expect(r1.architect).toEqual([expect.objectContaining({ outcome: 'failed', error: 'Error: GitHub 502' })]);
    expect(early.archived).toEqual([]);                                     // b waits too: the tick stops at a failure
    const late = fakeControl({ architect: [job('a', MAX_READS), job('b')], verify: [] });
    const r2 = await createQueueDrainer({ control: late.sql, author: {} as never, log: () => {} })();
    expect(r2.architect).toEqual([expect.objectContaining({ outcome: 'dead' }), expect.objectContaining({ outcome: 'opened' })]);
    expect(late.archived).toEqual(['architect:a', 'architect:b']);
  });

  it('a kick during a drain joins it: one drain per instance', async () => {
    let release!: () => void;
    behaviour = { a: () => new Promise((res) => { release = () => res({ outcome: 'opened' }); }) };
    const c = fakeControl({ architect: [job('a')], verify: [] });
    const drain = createQueueDrainer({ control: c.sql, author: {} as never, log: () => {} });
    const first = drain(), second = drain();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await first;
    expect(c.archived).toEqual(['architect:a']);
  });
});

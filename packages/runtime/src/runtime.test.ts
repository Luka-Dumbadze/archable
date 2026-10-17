import { describe, expect, it } from 'vitest';
import { BundleNotFound, createBundles } from './bundles';
import { createContext } from './context';
import type { InTenant, Tx } from './db';
import { createEpochs, PinError, type Pin } from './epochs';

// A stand-in for withTenant(runtimeDb, …): records every query and answers from a queue of row sets.
function fakeDb(answers: unknown[][]) {
  const queries: { tenant: string; sql: string; values: unknown[] }[] = [];
  let transactions = 0;
  const inTenant: InTenant = async (tenantId, fn) => {
    transactions++;
    const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ tenant: tenantId, sql: strings.join('$').replace(/\s+/g, ' ').trim(), values });
      return Promise.resolve(answers.shift() ?? []);
    }) as unknown as Tx;
    return fn(tx);
  };
  return { inTenant, queries, get transactions() { return transactions; } };
}

const T = '11621771-15d1-42c1-87dd-447622867b52';
const D = 'sha256:' + 'a'.repeat(64);

describe('epochs.pin', () => {
  it('issues exactly one query and returns digest and epoch', async () => {
    const db = fakeDb([[{ digest: D, epoch: '3' }]]);
    expect(await createEpochs(db.inTenant).pin(T, 'prod')).toEqual({ tenantId: T, env: 'prod', digest: D, epoch: 3 });
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]!.sql).toMatch(/from public\.tenants where id = \$ and status = 'live'/);
  });

  it('is a read every turn, never a cache', async () => {
    const db = fakeDb([[{ digest: D, epoch: '1' }], [{ digest: 'sha256:' + 'b'.repeat(64), epoch: '2' }]]);
    const epochs = createEpochs(db.inTenant);
    await epochs.pin(T, 'prod');
    expect((await epochs.pin(T, 'prod')).epoch).toBe(2);       // a flip between turns is seen by the next turn
    expect(db.queries).toHaveLength(2);
  });

  it('refuses a tenant that is not live or has no active bundle', async () => {
    await expect(createEpochs(fakeDb([[]]).inTenant).pin(T, 'prod')).rejects.toMatchObject({ reason: 'not_live' });
    await expect(createEpochs(fakeDb([[{ digest: null, epoch: '0' }]]).inTenant).pin(T, 'prod')).rejects.toMatchObject({ reason: 'no_active_bundle' });
  });

  it('refuses preview environments without a query (Phase 4)', async () => {
    const db = fakeDb([]);
    await expect(createEpochs(db.inTenant).pin(T, 'pr-58')).rejects.toBeInstanceOf(PinError);
    expect(db.queries).toHaveLength(0);
  });
});

describe('bundles.load', () => {
  const bundle = (n: number) => ({ apiVersion: 'archable.dev/v3', n });

  it('serves a second load of the same digest from the cache', async () => {
    const db = fakeDb([[{ bundle: bundle(1) }]]);
    const bundles = createBundles(db.inTenant);
    const a = await bundles.load(T, D);
    const b = await bundles.load(T, D);
    expect(b).toBe(a);
    expect(db.queries).toHaveLength(1);
  });

  it('shares one fetch between concurrent loads', async () => {
    const db = fakeDb([[{ bundle: bundle(1) }]]);
    const bundles = createBundles(db.inTenant);
    const [a, b] = await Promise.all([bundles.load(T, D), bundles.load(T, D)]);
    expect(b).toBe(a);
    expect(db.queries).toHaveLength(1);
  });

  it('keys by tenant and digest, and trims the least recently used', async () => {
    const db = fakeDb([[{ bundle: bundle(1) }], [{ bundle: bundle(2) }], [{ bundle: bundle(3) }], [{ bundle: bundle(1) }]]);
    const bundles = createBundles(db.inTenant, 2);
    await bundles.load(T, 'sha256:1');
    await bundles.load(T, 'sha256:2');
    await bundles.load(T, 'sha256:1');                         // 1 is now the most recent
    await bundles.load(T, 'sha256:3');                         // evicts 2
    expect(bundles.size).toBe(2);
    await bundles.load(T, 'sha256:1');                         // still cached
    expect(db.queries).toHaveLength(3);
    await bundles.load('other-tenant', 'sha256:1');            // another tenant reads under its own RLS context
    expect(db.queries.at(-1)!.tenant).toBe('other-tenant');
  });

  it('does not cache a missing bundle', async () => {
    const db = fakeDb([[], [{ bundle: bundle(1) }]]);
    const bundles = createBundles(db.inTenant);
    await expect(bundles.load(T, D)).rejects.toBeInstanceOf(BundleNotFound);
    await expect(bundles.load(T, D)).resolves.toEqual(bundle(1));
    expect(db.queries).toHaveLength(2);
  });
});

describe('context.load', () => {
  const pin: Pin = { tenantId: T, env: 'prod', digest: D, epoch: 1 };

  it('loads chapter, customer and the tail, oldest first, in one transaction', async () => {
    const db = fakeDb([
      [{ id: 'ch1', kind: 'order_new', status: 'open', summary: null }],
      [{ id: 'cu1', attrs: { phone: '+995555000111', age_verified: true } }],
      [{ direction: 'out', body: 'Saperavi 2021 is 35.00 GEL.' }, { direction: 'in', body: 'How much is the Saperavi?' }],
    ]);
    const ctx = await createContext(db.inTenant).load(T, pin, { id: 'c1', customer_id: 'cu1', active_chapter: 'ch1', agent_paused_until: null },
                                                       { tail: 20, locale: 'ka' });
    expect(db.transactions).toBe(1);
    expect(ctx.chapter?.id).toBe('ch1');
    expect(ctx.customer?.attrs.age_verified).toBe(true);
    expect(ctx.messages).toEqual([
      { role: 'user', content: 'How much is the Saperavi?' },
      { role: 'assistant', content: 'Saperavi 2021 is 35.00 GEL.' },
    ]);
    expect(db.queries.at(-1)!.values).toContain(20);
  });

  it('skips the chapter and customer reads for a new conversation', async () => {
    const db = fakeDb([[]]);
    const ctx = await createContext(db.inTenant).load(T, pin, { id: 'c1', customer_id: null, active_chapter: null, agent_paused_until: null },
                                                       { tail: 6, locale: 'en' });
    expect(db.queries).toHaveLength(1);
    expect(ctx).toEqual({ chapter: null, customer: null, messages: [], locale: 'en' });
  });
});

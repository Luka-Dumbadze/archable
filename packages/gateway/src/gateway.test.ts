import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, type Bundle } from '@archable/compiler';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { cedarDecide } from './cedar';
import type { InTenant, Tx } from './db';
import { createFacts } from './facts';
import { toolGateway, type Executor, type GatewayCtx } from './gateway';

const ROOT = fileURLToPath(new URL('../../../fixtures/marani', import.meta.url));
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const files = Object.fromEntries(walk(ROOT).map((p) => [relative(ROOT, p).split(sep).join('/'), readFileSync(p, 'utf8')]));
const marani: Bundle = compile({ files }, YAML.parse(files['archable.lock']!)).bundle;

const T = '11621771-15d1-42c1-87dd-447622867b52';
const NINO = 'aaaaaaaa-0000-4000-8000-0000000000e1';             // customer record id
const ORDER = 'aaaaaaaa-0000-4000-8000-0000000000e3';
const CHAPTER = 'aaaaaaaa-0000-4000-8000-000000006001';

type Record_ = { id: string; entity_type: string; natural_key: string; attrs: Record<string, unknown> };
const records: Record_[] = [
  { id: NINO, entity_type: 'customer', natural_key: '+995555000111', attrs: { name: 'Nino', phone: '+995555000111', age_verified: true, segment: 'regular' } },
  { id: 'aaaaaaaa-0000-4000-8000-0000000000e2', entity_type: 'customer', natural_key: '+995555000222',
    attrs: { name: 'Levan', phone: '+995555000222', age_verified: false, segment: 'new' } },
  { id: ORDER, entity_type: 'order', natural_key: 'M-00012', attrs: { number: 'M-00012', customer: NINO, lines: [{ wine: 'MRN-SAP-2021', qty: 2, unit_price: 3500 }],
    discount_pct: 0, surcharge: 0, payment: 'card_link', delivery: 'standard', status: 'confirmed' } },
];

// A stand-in for withTenant(runtimeDb, …): answers record reads from `records` and groups writes by transaction.
function fakeDb() {
  const transactions: string[][] = [];
  const inTenant: InTenant = async (_tenantId, fn) => {
    const statements: string[] = [];
    transactions.push(statements);
    const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('$').replace(/\s+/g, ' ').trim();
      statements.push(sql);
      if (sql.startsWith('select id, natural_key, attrs from public.records')) {
        const [, , type, value] = values as [string, string, string, string];
        const byId = sql.includes(' id = $');
        return Promise.resolve(records.filter((r) => r.entity_type === type && (byId ? r.id === value : r.natural_key === value)));
      }
      return Promise.resolve([]);
    }) as unknown as Tx;
    (tx as unknown as { json: (v: unknown) => unknown }).json = (v) => v;
    return fn(tx);
  };
  const writes = () => transactions.filter((t) => t.some((s) => !s.startsWith('select')));
  return { inTenant, transactions, writes };
}

function gateway(over: Partial<GatewayCtx> = {}, executors: Record<string, Executor> = {}, mode: 'live' | 'simulate' = 'live') {
  const db = fakeDb();
  const ctx: GatewayCtx = {
    tenantId: T, turnId: 'bbbbbbbb-0000-4000-8000-000000000001', pin: { env: 'prod', digest: 'sha256:x' }, bundle: marani,
    principal: { type: 'Agent', id: 'cellar_master' }, chapterId: CHAPTER, session: { channel: 'web', linkedCustomerId: null }, ...over,
  };
  const ran: string[] = [];
  const wrapped = Object.fromEntries(Object.entries(executors).map(([k, f]) => [k, Object.assign((async (i, c) => { ran.push(k); return f(i, c); }) as Executor,
    f.simulates ? { simulates: true as const } : {})]));
  const gw = toolGateway(ctx, {
    inTenant: db.inTenant, facts: createFacts(db.inTenant), executors: wrapped, connectionsMode: mode,
    quotes: { price: async () => ({ surcharge: 0, total: 7000 }) },
  });
  return { gw, db, ran };
}

const lines = [{ wine: 'MRN-SAP-2021', qty: 2, unit_price: 3500 }];
const orderInput = (customer: string) => ({ customer, lines, delivery: 'standard', payment: 'card_link' });

describe('Cedar errors deny (I3)', () => {
  it('a missing context.customer denies order.create: the request fails the schema (cedar_failure)', async () => {
    const { gw, db, ran } = gateway({}, { 'order.create': async () => ({ order: { id: 'x' } }) });
    const out = await gw.call('order.create', orderInput('cccccccc-0000-4000-8000-000000000000'));   // no such customer
    expect(out).toEqual({ denied: true, policies: ['cedar_failure'] });
    expect(ran).toEqual([]);
    expect(db.writes().flat().filter((s) => s.startsWith('insert into public.tool_calls'))).toHaveLength(1);
  });

  it('without a schema, the same request evaluates with an error: denied as policy_error, not allowed', () => {
    const noSchema = { ...marani.policies, schema: null };
    const input = { ...orderInput(NINO), discount_pct: 0 };
    expect(cedarDecide(noSchema, { type: 'Agent', id: 'cellar_master' }, 'order.create',
      { input, approvals: [], quote: { surcharge: 0, total: 7000 } })).toEqual({ allow: false, reasons: ['policy_error'] });
  });

  it('a malformed context value denies', () => {
    expect(cedarDecide(marani.policies, { type: 'Agent', id: 'cellar_master' }, 'order.create', { input: 'nonsense' }).allow).toBe(false);
  });

  it('allows a verified adult inside the caps, and the age gate denies a minor', async () => {
    const ok = gateway({}, { 'order.create': async () => ({ order: { id: ORDER, number: 'M-00012', total: 7000, status: 'draft' } }) });
    expect(await ok.gw.call('order.create', orderInput(NINO))).toMatchObject({ order: { number: 'M-00012' } });
    const minor = gateway({}, { 'order.create': async () => ({ order: { id: 'x' } }) });
    expect(await minor.gw.call('order.create', orderInput('aaaaaaaa-0000-4000-8000-0000000000e2'))).toEqual({ denied: true, policies: ['order.age_gate'] });
  });

  it('a record without its defaulted fields still satisfies the schema (age_verified: false applies)', async () => {
    records.push({ id: 'aaaaaaaa-0000-4000-8000-0000000000e9', entity_type: 'customer', natural_key: '+995555000333',
                   attrs: { name: 'Test Customer', phone: '+995555000333' } });                // as customer.upsert writes it
    const { gw } = gateway({}, { 'order.create': async () => ({ order: { id: ORDER } }) });
    expect(await gw.call('order.create', orderInput('aaaaaaaa-0000-4000-8000-0000000000e9'))).toEqual({ denied: true, policies: ['order.age_gate'] });
  });

  it('the discount cap reads the filled default and the model’s value', async () => {
    const { gw } = gateway({}, { 'order.create': async () => ({ order: { id: ORDER } }) });
    expect(await gw.call('order.create', { ...orderInput(NINO), discount_pct: 50 })).toEqual({ denied: true, policies: ['order.discount_cap'] });
  });

  it('an agent cannot call a tool it does not list (no generated permit)', async () => {
    const { gw } = gateway({ principal: { type: 'Agent', id: 'dispatch_node' } }, { 'catalog.search': async () => ({ items: [] }) });
    expect(await gw.call('catalog.search', { query: 'saperavi' })).toEqual({ denied: true, policies: [] });
  });
});

describe('privacy.status_needs_phone (plan §1.5)', () => {
  const status: Executor = async () => ({ status: 'assigned', eta: '2026-10-18T18:00:00Z' });

  it('denies delivery.status with the wrong phone', async () => {
    const { gw, ran } = gateway({}, { 'delivery.status': status });
    expect(await gw.call('delivery.status', { order: 'M-00012', phone: '+995555000999' })).toEqual({ denied: true, policies: ['privacy.status_needs_phone'] });
    expect(ran).toEqual([]);
  });

  it('allows it with the order’s customer phone, typed on the web', async () => {
    const { gw } = gateway({}, { 'delivery.status': status });
    expect(await gw.call('delivery.status', { order: 'M-00012', phone: '+995555000111' })).toEqual({ status: 'assigned', eta: '2026-10-18T18:00:00Z' });
  });

  it('on Telegram the phone comes from the customer linked to the chat, not from the model', async () => {
    const linked = gateway({ session: { channel: 'telegram', linkedCustomerId: NINO } }, { 'delivery.status': status });
    expect(await linked.gw.call('delivery.status', { order: 'M-00012', phone: '+995555000999' })).toMatchObject({ status: 'assigned' });
    const other = gateway({ session: { channel: 'telegram', linkedCustomerId: 'aaaaaaaa-0000-4000-8000-0000000000e2' } }, { 'delivery.status': status });
    expect(await other.gw.call('delivery.status', { order: 'M-00012', phone: '+995555000111' })).toEqual({ denied: true, policies: ['privacy.status_needs_phone'] });
  });

  it('an unknown order denies', async () => {
    const { gw } = gateway({}, { 'delivery.status': status });
    expect((await gw.call('delivery.status', { order: 'M-99999', phone: '+995555000111' }) as { denied?: boolean }).denied).toBe(true);
  });
});

describe('tool_calls and chapter facts in one transaction (plan §5.5 [c])', () => {
  it('order.quote writes chapters.last_quote_total in the same transaction as its tool_calls row', async () => {
    const { gw, db } = gateway({}, { 'order.quote': async () => ({ surcharge: 1000, total: 8000 }) });
    expect(await gw.call('order.quote', { lines, delivery: 'express' })).toEqual({ surcharge: 1000, total: 8000 });
    const writes = db.writes();
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toMatch(/^insert into public\.tool_calls/);
    expect(writes[0]![1]).toMatch(/^update public\.chapters set last_quote_total = \$, last_quote_at = now\(\)/);
    expect(gw.evidence()).toEqual([{ tool: 'order.quote', input: { lines, delivery: 'express', discount_pct: 0 }, output: { surcharge: 1000, total: 8000 } }]);
  });

  it('order.create links the chapter to the order in the same transaction', async () => {
    const { gw, db } = gateway({}, { 'order.create': async () => ({ order: { id: ORDER, number: 'M-00012', total: 7000, status: 'draft' } }) });
    await gw.call('order.create', orderInput(NINO));
    const [log, link] = db.writes()[0]!;
    expect(log).toMatch(/^insert into public\.tool_calls /);
    expect(link).toMatch(/^update public\.chapters set order_id = \$ where tenant_id = \$ and id = \$$/);
  });

  it('a failing tool logs an error and a failure, and returns tool_unavailable', async () => {
    const { gw, db } = gateway({}, { 'catalog.search': async () => { throw new Error('connection reset'); } });
    expect(await gw.call('catalog.search', { query: 'kisi' })).toEqual({ error: 'tool_unavailable' });
    expect(db.writes()[0]!.map((s) => s.slice(0, 32))).toEqual(['insert into public.tool_calls (t', 'insert into public.failures (ten']);
    expect(gw.evidence()).toEqual([]);
  });
});

describe('simulation and caller attribution', () => {
  it('CONNECTIONS_MODE=simulate never runs an external tool; output has a job id and an ETA 45 min ahead', async () => {
    const { gw, ran } = gateway({ principal: { type: 'Trigger', id: 'dispatch_on_confirm' } }, { 'delivery.dispatch': async () => ({ real: true }) }, 'simulate');
    const out = await gw.call('delivery.dispatch', { order: ORDER }) as { job_id: string; eta: string };
    expect(ran).toEqual([]);
    expect(out.job_id).toMatch(/^sim_/);
    expect(Math.abs(new Date(out.eta).getTime() - Date.now() - 45 * 60_000)).toBeLessThan(5_000);
    expect(gw.caller).toBe('trigger:dispatch_on_confirm');
  });

  it('a preview simulates too, even in live mode', async () => {
    const { gw, ran } = gateway({ pin: { env: 'pr-58', digest: 'sha256:x' }, principal: { type: 'Trigger', id: 'notify_on_job_status' } },
                                 { 'customer.notify': async () => ({ sent: true }) });
    await gw.call('customer.notify', { job: ORDER });
    expect(ran).toEqual([]);
  });

  it('agents are attributed as agent:<id>, and their AI SDK tools are exactly agents.*.tools', () => {
    const { gw } = gateway();
    expect(gw.caller).toBe('agent:cellar_master');
    expect(Object.keys(gw.tools).sort()).toEqual(['catalog_search', 'customer_upsert', 'delivery_status', 'handoff_staff', 'order_create', 'order_quote']);
  });
});

describe('idempotency keys (trigger retries)', () => {
  it('a new key runs the tool once and logs one row (duplicates: runtime/src/triggers.test.ts)', async () => {
    const { gw, ran, db } = gateway({ principal: { type: 'Trigger', id: 'notify_on_job_status' } }, { 'customer.notify': async () => ({ sent: true }) });
    expect(await gw.call('customer.notify', { job: ORDER }, { idempotencyKey: 'k1' })).toEqual({ sent: true });
    const inserts = db.writes().flat().filter((q) => q.startsWith('insert into public.tool_calls'));
    expect(inserts).toHaveLength(1);
    expect(ran).toEqual(['customer.notify']);
  });

  it('a self-simulating executor runs in simulate mode with simulated: true', async () => {
    let seen: unknown;
    const notify = Object.assign(async (_i: Record<string, unknown>, c: { simulated: boolean }) => { seen = c.simulated; return { sent: false, simulated: true }; }, { simulates: true as const });
    const { gw } = gateway({ principal: { type: 'Trigger', id: 'notify_on_job_status' } }, { 'customer.notify': notify as never }, 'simulate');
    expect(await gw.call('customer.notify', { job: ORDER })).toEqual({ sent: false, simulated: true });
    expect(seen).toBe(true);
  });
});

describe('message.send (the send guard)', () => {
  const D = 'sha256:' + 'd'.repeat(64);
  const signals = (g: string, c: string, digest = D) => ({
    grounded: { verdict: g, p: 0.95, payload_digest: digest }, commitment: { verdict: c, p: 0.05, payload_digest: digest }, answeredBy: 'typesafe-ai/jev',
  });

  it('allows a draft whose signals pass and are bound to its digest', () => {
    expect(gateway().gw.authorize('message.send', { payload_digest: D, signals: signals('pass', 'pass') })).toEqual({ allow: true, reasons: ['permit.agent.cellar_master'] });
  });

  it('denies a failing signal, signals for another draft, and the FAILED signals', () => {
    const { gw } = gateway();
    expect(gw.authorize('message.send', { payload_digest: D, signals: signals('fail', 'pass') }).reasons).toEqual(['send.requires_grounding']);
    expect(gw.authorize('message.send', { payload_digest: D, signals: signals('pass', 'pass', 'sha256:other') }).allow).toBe(false);
    const failed = { grounded: { verdict: 'fail', p: null, payload_digest: '' }, commitment: { verdict: 'fail', p: null, payload_digest: '' }, answeredBy: 'none' };
    expect(gw.authorize('message.send', { payload_digest: D, signals: failed }).allow).toBe(false);
  });
});

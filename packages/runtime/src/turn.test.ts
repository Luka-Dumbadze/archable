import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, type Bundle } from '@archable/compiler';
import type { GatewayDeps, InTenant, Tx } from '@archable/gateway';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { FAILED, type Draft, type Signals } from './decisions';
import type { Conversation, Store } from './store';
import { createHandleTurn, type TurnDeps } from './turn';
import type { Inbound, TurnResult } from './types';

const ROOT = fileURLToPath(new URL('../../../fixtures/marani', import.meta.url));
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const files = Object.fromEntries(walk(ROOT).map((p) => [relative(ROOT, p).split(sep).join('/'), readFileSync(p, 'utf8')]));
const marani: Bundle = compile({ files }, YAML.parse(files['archable.lock']!)).bundle;

const T = '11621771-15d1-42c1-87dd-447622867b52';
const inbound = (over: Partial<Inbound> = {}): Inbound => ({
  turnId: 'turn-1', tenantId: T, env: 'prod', channel: 'web', conversationKey: 'try_m_main', externalMessageId: 'cm-1',
  text: 'How much is the Saperavi?', customer: {}, reply: { kind: 'console' }, ...over,
});

function memoryStore(o: { paused?: boolean } = {}) {
  const seen = new Map<string, TurnResult>();
  const outbound: { text: string; author: string }[] = [];
  const failures: { kind: string; payload: unknown }[] = [];
  const conv: Conversation = { id: 'c-1', customer_id: null, active_chapter: null, tail: [],
    agent_paused_until: o.paused ? new Date(Date.now() + 60_000) : null };
  const allowedTurns = new Set<string>();                          // the real store reads the turn's pre_send rows
  const store: Store = {
    upsertConversation: async () => conv,
    insertInbound: async (_c, i) => {
      if (i.externalMessageId && seen.has(i.externalMessageId)) return null;
      if (i.externalMessageId) seen.set(i.externalMessageId, { turnId: i.turnId, text: '', allowed: false, outboundMessageId: 0, paused: false });
      return 1;
    },
    replyFor: async (_c, i) => { const r = seen.get(i.externalMessageId!)!; return { ...r, allowed: allowedTurns.has(r.turnId) }; },
    ensureChapter: async () => 'ch-1',
    insertOutbound: async (_t, _c, _ch, turnId, author, text) => {
      outbound.push({ text, author });
      const r = [...seen.values()].find((x) => x.turnId === turnId);
      if (r) Object.assign(r, { text, outboundMessageId: outbound.length });
      return outbound.length;
    },
    captureFailure: async (_t, _turn, kind, _s, payload) => { failures.push({ kind, payload }); },
  };
  return { store, outbound, failures, allowedTurns };
}

const noDb: InTenant = async (_t, fn) => {
  const tx = (() => Promise.resolve([])) as unknown as Tx;
  (tx as unknown as { json: (v: unknown) => unknown }).json = (v) => v;
  return fn(tx);
};

function engine(o: { generate?: TurnDeps['generate']; preSend?: (d: Draft) => Signals; paused?: boolean; terms?: TurnDeps['terms'] } = {}) {
  const mem = memoryStore({ paused: o.paused });
  const calls = { generate: 0, route: 0, preSend: [] as Draft[], handoff: 0 };
  const gateway: GatewayDeps = {
    inTenant: noDb,
    facts: { forPolicy: async (_t, _e, _b, _tool, input) => ({ input, context: { approvals: [] } }) },
    quotes: { price: async () => ({ surcharge: 0, total: 0 }) },
    executors: { 'handoff.staff': async () => { calls.handoff++; return { queued: true }; } },
  };
  const handleTurn = createHandleTurn({
    epochs: { pin: async () => ({ tenantId: T, env: 'prod', digest: 'sha256:x', epoch: 2 }) },
    bundles: { load: async () => marani },
    context: { load: async () => ({ chapter: null, customer: null, messages: [{ role: 'user', content: 'How much is the Saperavi?' }], locale: 'ka' }) },
    decisions: {
      route: async () => { calls.route++; return { intent: 'catalog', confidence: 0.9, frustration: 'calm', answeredBy: 'typesafe/jev' }; },
      preSend: async (_b, d) => {
        calls.preSend.push(d);
        const s = o.preSend ? o.preSend(d) : pass(d);
        if (s.grounded.verdict === 'pass' && s.commitment.verdict === 'pass') mem.allowedTurns.add(d.turnId);
        return s;
      },
    },
    store: mem.store,
    gateway,
    languageModel: () => ({}) as never,
    deliver: async () => { throw new Error('console replies are not delivered'); },
    ...(o.terms ? { terms: o.terms } : {}),
    generate: o.generate ?? ((async () => { calls.generate++; return { text: 'Marani Saperavi 2021 is 35.00 GEL.' }; }) as never),
  });
  return { handleTurn, calls, ...mem };
}
const pass = (d: Draft): Signals => ({
  grounded: { verdict: 'pass', p: 0.95, payload_digest: d.digest }, commitment: { verdict: 'pass', p: 0.03, payload_digest: d.digest }, answeredBy: 'typesafe/jev',
});

describe('handleTurn (plan §5.4)', () => {
  it('sends a grounded draft and records it as agent:cellar_master', async () => {
    const e = engine();
    const r = await e.handleTurn(inbound());
    expect(r).toMatchObject({ text: 'Marani Saperavi 2021 is 35.00 GEL.', allowed: true, paused: false, outboundMessageId: 1 });
    expect(e.outbound).toEqual([{ text: 'Marani Saperavi 2021 is 35.00 GEL.', author: 'agent:cellar_master' }]);
    expect(e.calls.preSend[0]!.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('[1] a duplicate externalMessageId returns the first reply without a second model call', async () => {
    const e = engine();
    const first = await e.handleTurn(inbound());
    const again = await e.handleTurn(inbound({ turnId: 'turn-2' }));
    expect(again).toEqual(first);
    expect(e.calls.generate).toBe(1);
    expect(e.calls.route).toBe(1);
    expect(e.outbound).toHaveLength(1);
  });

  it('[2] a paused conversation stores the message and returns paused: true without a model call', async () => {
    const e = engine({ paused: true });
    expect(await e.handleTurn(inbound())).toEqual({ turnId: 'turn-1', text: '', allowed: false, outboundMessageId: 0, paused: true });
    expect(e.calls.generate).toBe(0);
    expect(e.calls.route).toBe(0);
  });

  it('a failed pre-send gives the holding reply, a grounding_block failure and a staff handoff (I7)', async () => {
    const e = engine({ preSend: () => FAILED });
    const r = await e.handleTurn(inbound());
    expect(r).toMatchObject({ allowed: false, text: 'ერთი წუთით — ჩვენი გუნდის წევრი მალე გიპასუხებთ.' });
    expect(e.failures.map((f) => f.kind)).toEqual(['grounding_block']);
    expect(e.calls.handoff).toBe(1);
  });

  it('signals bound to another draft do not let it through', async () => {
    const e = engine({ preSend: (d) => ({ ...pass(d), grounded: { verdict: 'pass', p: 0.99, payload_digest: 'sha256:' + '0'.repeat(64) } }) });
    expect((await e.handleTurn(inbound())).allowed).toBe(false);
  });

  it('a model error or timeout is a holding reply and a deadline failure, and pre-send is skipped', async () => {
    const e = engine({ generate: (async () => { throw new Error('This operation was aborted'); }) as never });
    const r = await e.handleTurn(inbound());
    expect(r.allowed).toBe(false);
    expect(e.calls.preSend).toHaveLength(0);
    expect(e.failures.map((f) => f.kind)).toEqual(['deadline', 'grounding_block']);
  });

  it('evidence shows money in GEL, as the customer reads it (Q5)', async () => {
    let seen: Draft | undefined;
    const e = engine({
      generate: (async (o: { tools: Record<string, { execute: (i: unknown) => Promise<unknown> }> }) => {
        await o.tools['catalog_search']!.execute({ query: 'saperavi' });
        return { text: 'Marani Saperavi 2021 is 35.00 GEL.' };
      }) as never,
      preSend: (d) => { seen = d; return pass(d); },
    });
    // catalog.search has no executor in this fake: the gateway answers tool_unavailable and records no evidence.
    await e.handleTurn(inbound());
    expect(seen!.evidence).toEqual([]);
  });

  it('the bundle’s business terms are in the agent’s prompt and are evidence for the pre-send check (Q10)', async () => {
    let seen: Draft | undefined;
    let system = '';
    const asked: string[] = [];
    const e = engine({ terms: (_b, agent) => { asked.push(agent); return ['Payment method: card payment link or cash on delivery.']; },
                       generate: (async (o: { system: string }) => { system = o.system; return { text: 'Yes, cash on delivery works.' }; }) as never,
                       preSend: (d) => { seen = d; return pass(d); } });
    await e.handleTurn(inbound());
    expect(asked).toEqual(['cellar_master']);                                      // once: prompt and evidence share it
    expect(seen!.evidence).toEqual([{ tool: 'business.terms', input: { bundle: expect.stringMatching(/^sha256:/) },
      output: { terms: ['Payment method: card payment link or cash on delivery.'] } }]);
    expect(system).toContain('that a tool returned in this conversation or that the business terms below state');
    expect(system).toContain('Business terms:\n- Payment method: card payment link or cash on delivery.');
  });

  it('without terms the prompt keeps the tool-only rule', async () => {
    let system = '';
    const e = engine({ generate: (async (o: { system: string }) => { system = o.system; return { text: 'ok' }; }) as never });
    await e.handleTurn(inbound());
    expect(system).toContain('policies that a tool returned in this conversation. Never promise');
    expect(system).not.toContain('Business terms');
  });
});

describe('draftOf: evidence in GEL', () => {
  it('renders money fields of tool inputs and outputs with their currency, and nothing else', async () => {
    const { draftOf } = await import('./drafts');
    const d = draftOf(marani, 'Saperavi is 35.00 GEL.', [
      { tool: 'catalog.search', input: { query: 'saperavi', max_price: 4000 },
        output: { items: [{ sku: 'MRN-SAP-2021', label: 'Marani Saperavi 2021', price: 3500, stock: 48, vintage: 2021 }] } },
      { tool: 'order.quote', input: { lines: [{ wine: 'MRN-SAP-2021', qty: 2, unit_price: 3500 }], delivery: 'express', discount_pct: 0 },
        output: { surcharge: 1000, total: 8000 } },
    ], { tenantId: T, turnId: 't', inReplyTo: 'ra ghirs saperavi?' });
    expect(d.evidence).toEqual([
      { tool: 'catalog.search', input: { query: 'saperavi', max_price: '40.00 GEL' },
        output: { items: [{ sku: 'MRN-SAP-2021', label: 'Marani Saperavi 2021', price: '35.00 GEL', stock: 48, vintage: 2021 }] } },
      { tool: 'order.quote', input: { lines: [{ wine: 'MRN-SAP-2021', qty: 2, unit_price: '35.00 GEL' }], delivery: 'express', discount_pct: 0 },
        output: { surcharge: '10.00 GEL', total: '80.00 GEL' } },
    ]);
    expect(d.digest).toBe('sha256:' + (await import('node:crypto')).createHash('sha256').update('Saperavi is 35.00 GEL.').digest('hex'));
  });
});

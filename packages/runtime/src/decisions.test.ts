import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, type Bundle } from '@archable/compiler';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { createDecisions, DeadlineExceeded, FAILED, PRIMARY, type DecisionRow, type Draft } from './decisions';

// The real compiled Marani bundle: decision heads, thresholds and the fallback model as production sees them.
const ROOT = fileURLToPath(new URL('../../../fixtures/marani', import.meta.url));
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const files = Object.fromEntries(walk(ROOT).map((p) => [relative(ROOT, p).split(sep).join('/'), readFileSync(p, 'utf8')]));
const marani: Bundle = compile({ files }, YAML.parse(files['archable.lock']!)).bundle;

// Thresholds as compiled from the spec, so these tests follow calibration changes (evals/calibration).
type Head = { pass_at?: number; block_at?: number; escalate?: { probability_between?: [number, number] } };
const G = marani.decisions['send.grounded'] as Head;
const C = marani.decisions['send.commitment'] as Head;
const mid = (b: [number, number]) => (b[0] + b[1]) / 2;
const withDeadlines = (route: number, preSend: number): Bundle => ({ ...marani, deadlines: { ...marani.deadlines, route, pre_send: preSend } });

type Call = { questions: Record<string, Record<string, unknown>>; providerOptions?: { gateway?: { models?: unknown[] } }; abortSignal?: AbortSignal; maxRetries?: number };

function harness(answer: (call: Call) => Promise<unknown>) {
  const calls: Call[] = [];
  const rows: DecisionRow[] = [];
  const decide = (async (call: Call) => { calls.push(call); return answer(call); }) as never;
  const decisions = createDecisions({ decide, log: async (r) => { rows.push(...r); } });
  return { decisions, calls, rows };
}
const flush = () => new Promise((r) => setTimeout(r, 0));          // logging is fire-and-forget
const never = () => new Promise<never>(() => {});

const inbound = { tenantId: 't-1', turnId: 'turn-1', text: 'gamarjoba, kurierze naghdit gadaxda shemidzlia?' };
const draft: Draft = {
  tenantId: 't-1', turnId: 'turn-1', text: 'Marani Saperavi 2021 is 35.00 GEL.', digest: 'sha256:' + 'd'.repeat(64),
  evidence: [{ tool: 'catalog.search', output: { items: [{ sku: 'MRN-SAP-2021', price: 3500 }] } }], inReplyTo: 'How much is the Saperavi?',
};

describe('route', () => {
  it('asks route.intent and turn.signals in one request, with the field names of ai 7.0.143', async () => {
    const h = harness(async () => ({
      answers: {
        intent: { type: 'choice', choice: 'order_new', probabilities: { order_new: 0.82, catalog: 0.1, order_status: 0.03, complaint: 0.02, human: 0.02, other: 0.01 } },
        frustration: { type: 'score', score: 0.4 },
      },
      response: { modelId: PRIMARY },
    }));
    const r = await h.decisions.route(marani, inbound, [{ author: 'customer', body: 'hi' }]);
    expect(r).toEqual({ intent: 'order_new', confidence: 0.82, frustration: 'calm', answeredBy: PRIMARY });

    expect(h.calls).toHaveLength(1);
    const q = h.calls[0]!.questions;
    expect(q.intent).toMatchObject({ type: 'choice', criteria: (marani.decisions['route.intent'] as { criteria: object }).criteria });
    expect(typeof q.intent!.instructions).toBe('string');
    expect(q.frustration).toEqual({ type: 'score', instructions: 'How frustrated is the customer?', criteria: ['calm', 'impatient', 'frustrated', 'angry'] });
    expect(h.calls[0]!.providerOptions).toEqual({ gateway: { models: [{ model: marani.models.decision.fallback, when: { question: 'intent', confidenceBelow: 0.6 } }] } });
    expect(h.calls[0]!.maxRetries).toBe(0);

    await flush();
    expect(h.rows).toMatchObject([{ head: 'route.intent', stage: 'route', model: PRIMARY, fallback: false, verdict: 'order_new', turn_id: 'turn-1' }]);
  });

  it('maps a fractional score to its level and records when the fallback answered', async () => {
    const h = harness(async () => ({
      answers: { intent: { type: 'choice', choice: 'complaint' }, frustration: { type: 'score', score: 2.6 } },
      response: { modelId: 'google/gemini-3.8-flash' },
    }));
    const r = await h.decisions.route(marani, inbound, []);
    expect(r).toMatchObject({ intent: 'complaint', confidence: null, frustration: 'angry' });
    await flush();
    expect(h.rows[0]).toMatchObject({ model: 'google/gemini-3.8-flash', fallback: true });
  });

  it('returns null on a forced timeout (fails open) and logs it', async () => {
    const h = harness(never);
    const t0 = Date.now();
    expect(await h.decisions.route(withDeadlines(30, 2000), inbound, [])).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(h.calls[0]!.abortSignal?.aborted).toBe(true);           // the request itself is cancelled too
    await flush();
    expect(h.rows).toMatchObject([{ head: 'route.intent', verdict: 'timeout' }]);
  });

  it('returns null when the model refuses or the gateway fails', async () => {
    const h = harness(async () => { throw new Error('DecisionRefusalError: intent'); });
    expect(await h.decisions.route(marani, inbound, [])).toBeNull();
    await flush();
    expect(h.rows[0]!.verdict).toBe('error');
  });
});

describe('preSend', () => {
  const answers = (g: number, c: number, modelId = PRIMARY) => async () => ({
    answers: { grounded: { type: 'boolean', probability: g }, commitment: { type: 'boolean', probability: c } },
    response: { modelId },
  });

  it('asks both Booleans in one request and binds each verdict to the draft digest', async () => {
    const h = harness(answers(0.95, 0.05));
    const s = await h.decisions.preSend(marani, draft);
    expect(s).toEqual({
      grounded: { verdict: 'pass', p: 0.95, payload_digest: draft.digest },
      commitment: { verdict: 'pass', p: 0.05, payload_digest: draft.digest },
      answeredBy: PRIMARY,
    });
    expect(h.calls).toHaveLength(1);
    expect(Object.keys(h.calls[0]!.questions)).toEqual(['grounded', 'commitment']);
    expect(h.calls[0]!.providerOptions).toEqual({ gateway: { models: [{ model: marani.models.decision.fallback, when: { any: [
      { question: 'grounded', probabilityBetween: G.escalate!.probability_between },
      { question: 'commitment', probabilityBetween: C.escalate!.probability_between },
    ] } }] } });
    await flush();
    expect(h.rows.map((r) => [r.head, r.stage, r.verdict])).toEqual([['send.grounded', 'pre_send', 'pass'], ['send.commitment', 'pre_send', 'pass']]);
  });

  it('applies pass_at and block_at from the spec', async () => {
    expect((await harness(answers(G.pass_at! - 0.01, 0.05)).decisions.preSend(marani, draft)).grounded.verdict).toBe('fail');
    expect((await harness(answers(0.95, C.block_at!)).decisions.preSend(marani, draft)).commitment.verdict).toBe('fail');
    const s = await harness(answers(G.pass_at!, C.block_at! - 0.01)).decisions.preSend(marani, draft);
    expect([s.grounded.verdict, s.commitment.verdict]).toEqual(['pass', 'pass']);
  });

  it('returns FAILED on a forced timeout (fails closed) and logs both heads', async () => {
    const h = harness(never);
    const s = await h.decisions.preSend(withDeadlines(600, 30), draft);
    expect(s).toBe(FAILED);
    expect(s.grounded.verdict).not.toBe('pass');
    expect(s.grounded.payload_digest).not.toBe(draft.digest);       // nothing a Cedar rule could match to the draft
    await flush();
    expect(h.rows.map((r) => [r.head, r.verdict])).toEqual([['send.grounded', 'timeout'], ['send.commitment', 'timeout']]);
  });

  it('returns FAILED when a decision head is missing from the bundle', async () => {
    const h = harness(answers(0.99, 0.01));
    const broken = { ...marani, decisions: { ...marani.decisions, 'send.commitment': undefined } } as unknown as Bundle;
    expect(await h.decisions.preSend(broken, draft)).toBe(FAILED);
    expect(h.calls).toHaveLength(0);
  });

  it('a log failure never changes the answer', async () => {
    const decisions = createDecisions({ decide: answers(0.95, 0.05) as never, log: async () => { throw new Error('db down'); } });
    expect((await decisions.preSend(marani, draft)).grounded.verdict).toBe('pass');
  });
});

it('DeadlineExceeded names its budget', () => {
  expect(new DeadlineExceeded(600).message).toContain('600 ms');
});

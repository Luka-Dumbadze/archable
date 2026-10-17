import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, type Bundle } from '@archable/compiler';
import { experimental_decide } from 'ai';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { createDecisions, FAILED, type DecisionRow, type Draft } from './decisions';
import { TypeSafeError, typesafeDecisionModel } from './typesafe';

const ROOT = fileURLToPath(new URL('../../../fixtures/marani', import.meta.url));
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const files = Object.fromEntries(walk(ROOT).map((p) => [relative(ROOT, p).split(sep).join('/'), readFileSync(p, 'utf8')]));
const marani: Bundle = compile({ files }, YAML.parse(files['archable.lock']!)).bundle;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('typesafeDecisionModel (POST /v1/systemone)', () => {
  it('sends noul/choice/score with Bearer auth and maps the answers back', async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const model = typesafeDecisionModel({ apiKey: 'k-123', fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return json(200, { model: 'jev-1.14.0', usage: { input_tokens: 40, output_tokens: 3 }, answers: {
        grounded: { type: 'noul', noul: 0.93 },
        intent: { type: 'choice', choice: 'catalog', probabilities: { catalog: 0.9, other: 0.1 }, confidence: 0.88 },
        mood: { type: 'score', score: 0.4, probabilities: { 0: 0.6, 1: 0.4 }, legend: { 0: 'calm', 1: 'angry' }, confidence: 0.5 },
      } });
    }) as typeof fetch });
    const r = await experimental_decide({ model, state: { reply: 'Saperavi is 35.00 GEL.' }, maxRetries: 0, questions: {
      grounded: { type: 'boolean', instructions: 'Grounded?' },
      intent: { type: 'choice', instructions: 'Which?', criteria: { catalog: 'wines', other: 'else' } },
      mood: { type: 'score', instructions: 'How angry?', criteria: ['calm', 'angry'] },
    } });
    expect(sent[0]!.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((sent[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer k-123');
    expect(JSON.parse(sent[0]!.init.body as string)).toEqual({ model: 'jev-latest', state: { reply: 'Saperavi is 35.00 GEL.' }, questions: {
      grounded: { type: 'noul', instructions: 'Grounded?' },
      intent: { type: 'choice', instructions: 'Which?', criteria: { catalog: 'wines', other: 'else' } },
      mood: { type: 'score', instructions: 'How angry?', criteria: ['calm', 'angry'] },
    } });
    expect(r.answers.grounded.probability).toBe(0.93);
    expect(r.answers.intent).toMatchObject({ choice: 'catalog', probabilities: { catalog: 0.9, other: 0.1 } });
    expect(r.answers.mood.score).toBe(0.4);
    expect(r.response.modelId).toBe('typesafe/jev-1.14.0');
  });

  it('turns an HTTP error into TypeSafeError', async () => {
    const model = typesafeDecisionModel({ apiKey: 'bad', fetch: (async () => json(401, { error: 'invalid api key' })) as unknown as typeof fetch });
    await expect(experimental_decide({ model, state: 'x', maxRetries: 0, questions: { q: { type: 'boolean', instructions: 'q?' } } }))
      .rejects.toSatisfy((e: unknown) => String(e).includes('401') || e instanceof TypeSafeError);
  });
});

describe('direct primary with local fallback conditions', () => {
  const primary = typesafeDecisionModel({ apiKey: 'k', fetch: (async () => json(500, {})) as unknown as typeof fetch });
  const fallback = typesafeDecisionModel({ apiKey: 'f', model: 'fallback', fetch: (async () => json(500, {})) as unknown as typeof fetch });
  type Call = { model: unknown; questions: Record<string, unknown>; providerOptions?: unknown };
  function harness(answer: (call: Call, isPrimary: boolean) => Promise<unknown>, withFallback = true) {
    const calls: { primary: boolean; providerOptions?: unknown }[] = [];
    const rows: DecisionRow[] = [];
    const decide = (async (call: Call) => {
      const isPrimary = call.model === primary;
      calls.push({ primary: isPrimary, providerOptions: call.providerOptions });
      return answer(call, isPrimary);
    }) as never;
    return { d: createDecisions({ decide, primary, ...(withFallback ? { fallback } : {}), log: async (r) => { rows.push(...r); } }), calls, rows };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const route = (p: number, modelId: string) => ({
    answers: { intent: { type: 'choice', choice: 'catalog', probabilities: { catalog: p, other: 1 - p } }, frustration: { type: 'score', score: 0 } },
    response: { modelId },
  });
  const pre = (g: number, c: number, modelId: string) => ({
    answers: { grounded: { type: 'boolean', probability: g }, commitment: { type: 'boolean', probability: c } }, response: { modelId },
  });
  const inbound = { tenantId: 't', turnId: 'u', text: 'do you have kisi?' };
  const draft: Draft = { tenantId: 't', turnId: 'u', text: 'Yes, 42 GEL.', digest: 'sha256:' + 'e'.repeat(64), evidence: [], inReplyTo: 'kisi?' };

  it('a confident primary answers alone; no gateway options are sent', async () => {
    const h = harness(async () => route(0.9, 'typesafe/jev-1.14.0'));
    expect(await h.d.route(marani, inbound, [])).toMatchObject({ intent: 'catalog', answeredBy: 'typesafe/jev-1.14.0' });
    expect(h.calls).toEqual([{ primary: true, providerOptions: undefined }]);
    await flush();
    expect(h.rows[0]).toMatchObject({ model: 'typesafe/jev-1.14.0', fallback: false });
  });

  it('route below confidence_below (0.6) reruns on the fallback model', async () => {
    const h = harness(async (_c, isPrimary) => (isPrimary ? route(0.45, 'typesafe/jev-1.14.0') : route(0.8, 'google/gemini-3.8-flash')));
    expect(await h.d.route(marani, inbound, [])).toMatchObject({ answeredBy: 'google/gemini-3.8-flash', confidence: 0.8 });
    expect(h.calls.map((c) => c.primary)).toEqual([true, false]);
    await flush();
    expect(h.rows[0]).toMatchObject({ fallback: true });
  });

  it('pre-send inside an escalation band reruns on the fallback; outside it does not', async () => {
    const inBand = harness(async (_c, isPrimary) => (isPrimary ? pre(0.7, 0.05, 'typesafe/jev') : pre(0.95, 0.05, 'google/gemini-3.8-flash')));
    expect((await inBand.d.preSend(marani, draft)).grounded).toMatchObject({ verdict: 'pass', p: 0.95 });
    expect(inBand.calls.map((c) => c.primary)).toEqual([true, false]);
    const clear = harness(async () => pre(0.97, 0.02, 'typesafe/jev'));
    expect((await clear.d.preSend(marani, draft)).answeredBy).toBe('typesafe/jev');
    expect(clear.calls).toHaveLength(1);
  });

  it('a failing primary falls back; if the fallback fails too, route fails open and pre-send fails closed', async () => {
    const recovers = harness(async (_c, isPrimary) => { if (isPrimary) throw new Error('TypeSafe 529'); return pre(0.96, 0.03, 'google/gemini-3.8-flash'); });
    expect((await recovers.d.preSend(marani, draft)).answeredBy).toBe('google/gemini-3.8-flash');
    const down = harness(async () => { throw new Error('everything down'); });
    expect(await down.d.route(marani, inbound, [])).toBeNull();
    expect(await down.d.preSend(marani, draft)).toBe(FAILED);
  });

  it('the deadline covers the fallback: a hanging primary gives null without a second call', async () => {
    const h = harness(() => new Promise(() => {}));
    expect(await h.d.route({ ...marani, deadlines: { ...marani.deadlines, route: 30 } }, inbound, [])).toBeNull();
    await flush();
    expect(h.calls).toHaveLength(1);
    expect(h.rows[0]!.verdict).toBe('timeout');
  });
});

describe('direct primary without a fallback model (AI Gateway unavailable)', () => {
  const primary = typesafeDecisionModel({ apiKey: 'k', fetch: (async () => json(500, {})) as unknown as typeof fetch });
  const unsure = (async () => ({
    answers: { grounded: { type: 'boolean', probability: 0.7 }, commitment: { type: 'boolean', probability: 0.05 },
               intent: { type: 'choice', choice: 'catalog', probabilities: { catalog: 0.4, other: 0.6 } }, frustration: { type: 'score', score: 0 } },
    response: { modelId: 'typesafe/jev' },
  })) as never;
  const draft: Draft = { tenantId: 't', turnId: 'u', text: 'x', digest: 'sha256:' + 'f'.repeat(64), evidence: [], inReplyTo: 'y' };

  it('an escalation is unsure: route fails open, pre-send fails closed, one call each', async () => {
    let calls = 0;
    const d = createDecisions({ decide: (async (c: unknown) => { calls++; return (unsure as (c: unknown) => unknown)(c); }) as never, primary, log: async () => {} });
    expect(await d.route(marani, { tenantId: 't', turnId: 'u', text: 'hi' }, [])).toBeNull();
    expect(await d.preSend(marani, draft)).toBe(FAILED);
    expect(calls).toBe(2);
  });
});

describe('an unsure primary is logged with its answers', () => {
  it('pre-send in a band with no fallback logs verdict unsure and the probabilities', async () => {
    const primary = typesafeDecisionModel({ apiKey: 'k', fetch: (async () => json(500, {})) as unknown as typeof fetch });
    const rows: DecisionRow[] = [];
    const d = createDecisions({ primary, log: async (r) => { rows.push(...r); }, decide: (async () => ({
      answers: { grounded: { type: 'boolean', probability: 0.6 }, commitment: { type: 'boolean', probability: 0.02 } },
      response: { modelId: 'typesafe/jev-1.13.0' },
    })) as never });
    const draft: Draft = { tenantId: 't', turnId: 'u', text: 'x', digest: 'sha256:' + 'a'.repeat(64), evidence: [], inReplyTo: 'y' };
    expect(await d.preSend(marani, draft)).toBe(FAILED);
    await new Promise((r) => setTimeout(r, 0));
    expect(rows.map((r) => [r.head, r.verdict, r.model, (r.answer as { probability?: number }).probability]))
      .toEqual([['send.grounded', 'unsure', 'typesafe/jev-1.13.0', 0.6], ['send.commitment', 'unsure', 'typesafe/jev-1.13.0', 0.02]]);
  });
});

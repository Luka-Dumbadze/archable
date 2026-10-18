import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '@archable/compiler';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { clusterFailure } from './cluster';
import { parseCase, runOnce, wilsonLower, type EvalHost } from './evals';
import { heal } from './heal';
import { intake } from './intake';
import type { DesireStore, OpenDesire } from './store';
import type { Verification } from './verify';

const ROOT = fileURLToPath(new URL('../../../fixtures/marani', import.meta.url));
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const files = Object.fromEntries(walk(ROOT).map((p) => [relative(ROOT, p).replace(/\\/g, '/'), readFileSync(p, 'utf8').replace(/\r\n/g, '\n')]));
const lock = YAML.parse(files['archable.lock']!);
const base = compile({ files }, lock);

const CASE = parseCase(`id: d-14-01
desire: D-14
turns:
  - customer: "can I pay the courier in cash?"
expect:
  - tool_called: catalog.search
  - judge: { question: "Does the reply say cash on delivery is available?", min: 0.9 }
  - judge: { question: "Does the reply promise a discount?", max: 0.2 }
fixtures:
  customer: { phone: "+995555000111", age_verified: true }
`);

const judged: Record<string, string>[] = [];
const host = (p: Record<string, number>, tools: string[]): EvalHost => ({
  customer: async () => 'cust-1',
  turn: async (_k, text) => ({ turnId: 't1', text: `reply to ${text}`, allowed: true,
    evidence: tools.map((t) => `${t} returned {"items":[{"label":"Saperavi 2021","price":"35.00 GEL"}]}`) }),
  toolsCalled: async () => tools,
  judge: async (s, q) => { judged.push(s); return Object.fromEntries(Object.keys(q).map((id, i) => [id, Object.values(p)[i] ?? 0])); },
});

describe('eval cases (v3 §6.2)', () => {
  it('passes when the tool was called and every judge is on the right side of its threshold', async () => {
    expect((await runOnce(host({ a: 0.95, b: 0.1 }, ['catalog.search']), CASE, 'k')).pass).toBe(true);
  });
  it('the judge sees the tools’ results as evidence, money in GEL', async () => {
    await runOnce(host({ a: 0.95, b: 0.1 }, ['catalog.search']), CASE, 'k');
    expect(judged.at(-1)).toEqual({ transcript: 'customer: can I pay the courier in cash?\nagent: reply to can I pay the courier in cash?',
      evidence: 'catalog.search returned {"items":[{"label":"Saperavi 2021","price":"35.00 GEL"}]}' });
  });
  it('reports each failed assertion', async () => {
    const r = await runOnce(host({ a: 0.5, b: 0.6 }, []), CASE, 'k');
    expect(r.failures).toEqual(['catalog.search was not called', '"Does the reply say cash on delivery is available?" P=0.50 < 0.9',
      '"Does the reply promise a discount?" P=0.60 > 0.2']);
    expect(r.transcript).toBe('customer: can I pay the courier in cash?\nagent: reply to can I pay the courier in cash?');
  });
  it('a judge needs exactly one of min and max', () => {
    expect(() => parseCase('id: x\nturns: [{ customer: hi }]\nexpect: [{ judge: { question: "is it a reply?", min: 0.5, max: 0.6 } }]')).toThrow();
  });
  it('Wilson lower bound: 20 of 20 clears 0.75, 18 of 20 does not', () => {
    expect(wilsonLower(20, 20)).toBeGreaterThan(0.75);
    expect(wilsonLower(18, 20)).toBeLessThan(0.75);
  });
});

function fakeStore(open: OpenDesire[] = []): DesireStore & { created: unknown[]; added: unknown[] } {
  const created: unknown[] = [], added: unknown[] = [];
  return {
    created, added,
    open: async () => open,
    create: async (_t, d) => { created.push(d); return { id: 'new-id', number: 15, statement: d.statement, source: d.source, occurrences: 1 }; },
    addEvidence: async (_t, id, e) => { added.push(e); const x = open.find((o) => o.id === id)!; return { ...x, occurrences: x.occurrences + 1 }; },
    linkChapter: async () => {}, assignFailure: async () => {}, remove: async () => {},
  };
}
const decideWith = (answers: Record<string, string>) => (async () => ({
  answers: Object.fromEntries(Object.entries(answers).map(([k, choice]) => [k, { type: 'choice', choice, probabilities: { [choice]: 0.9 } }])),
})) as never;
const lane = { model: 'none' as never };

describe('intake (plan §7.7)', () => {
  const D14: OpenDesire = { id: 'd14', number: 14, statement: 'Customers can pay cash on delivery up to 300 GEL.', source: 'owner_request', occurrences: 1 };
  const at = '2026-10-18T09:00:00Z';
  it('a question opens nothing', async () => {
    const store = fakeStore();
    const r = await intake({ jev: 'jev' as never, lane, store, decide: decideWith({ intent: 'question' }) }, { tenantId: 't', text: 'how many orders today?', at });
    expect(r).toEqual({ outcome: 'not_a_change', intent: 'question', p: 0.9 });
    expect(store.created).toEqual([]);
  });
  it('the same request again is attached to the open desire as evidence', async () => {
    const store = fakeStore([D14]);
    const r = await intake({ jev: 'jev' as never, lane, store, decide: decideWith({ intent: 'change', same_as: 'D-14' }) },
      { tenantId: 't', text: 'again: cash to the courier please', at });
    expect(r).toMatchObject({ outcome: 'attached', desire: { number: 14, occurrences: 2 } });
    expect(store.added).toEqual([{ kind: 'owner_message', at, text: 'again: cash to the courier please' }]);
  });
});

describe('cluster (v3 §7.2)', () => {
  it('attaching a third occurrence triggers drafting', async () => {
    const store = fakeStore([{ id: 'd3', number: 3, statement: 'Answer in Russian.', source: 'failure_cluster', occurrences: 2 }]);
    const r = await clusterFailure({ jev: 'jev' as never, lane, store, decide: decideWith({ same_as: 'D-3' }) },
      { tenantId: 't', id: 7, turnId: 'turn', kind: 'grounding_block', severity: 3, summary: 'reply blocked', chapterId: 'ch', at: 'now' });
    expect(r).toMatchObject({ outcome: 'attached', desire: { number: 3, occurrences: 3 }, draft: true });
  });
});

describe('heal (v3 §7.2)', () => {
  const ok: Verification = { failToPass: true, passToPass: true, suites: {}, new_cases: 1, elva_drift: 'unknown', notRun: [] };
  const COD = [
    { op: 'add_enum', path: 'objects.order.fields.payment', value: 'cod', label: 'cash on delivery' },
    { op: 'add_policy', file: 'payment.cedar', id: 'payment.cod_limit', summary: 'Cash on delivery is refused above 300 GEL.',
      cedar: '@id("payment.cod_limit")\nforbid (principal is Agent, action == Action::"order.create", resource)\nwhen { context.input.payment == "cod" && context.quote.total > 30000 };' },
  ];
  const deps = (drafts: unknown[], verify = async () => ok) => {
    const seen: string[][] = [];
    return { seen, d: {
      desire: { number: 14, statement: 's', evidence: [] }, base: { files, lock, bundle: base.bundle, digest: base.digest },
      failing: { suite: 'regressions', id: 'd-14-01', yaml: 'id: d-14-01\nturns: [{ customer: hi }]\nexpect: [{ tool_called: catalog.search }]\n', case: CASE },
      maxAttempts: 2,
      draft: async (feedback: string[]) => { seen.push(feedback); return { desire: 'D-14', base_digest: 'x', rationale: 'r', ops: drafts[seen.length - 1] } as never; },
      verify,
    } };
  };

  it('a conflict feeds the next attempt; the second compiles at T3 with the failing case added', async () => {
    const { d, seen } = deps([[{ op: 'add_enum', path: 'objects.order.fields.payment', value: 'card_link', label: 'x' }], COD]);
    const r = await heal(d);
    expect(seen[1]![0]).toMatch(/already a value/);
    expect(r).toMatchObject({ outcome: 'ready', attempts: 2, radius: { tier: 3 } });
    expect(r.outcome === 'ready' && r.changeset.ops.map((o) => o.op)).toEqual(['add_enum', 'add_policy', 'add_eval']);
    expect(r.outcome === 'ready' && r.head.files['evals/regressions/d-14-01.yaml']).toContain('d-14-01');
  });

  it('a compile error is fed back; after max_patch_attempts the desire goes to the developer', async () => {
    const bad = [{ op: 'add_policy', file: 'payment.cedar', id: 'payment.x', cedar: '@id("payment.x")\nforbid (principal, action == Action::"no.such", resource);' }];
    const { d, seen } = deps([bad, bad]);
    const r = await heal(d);
    expect(seen[1]!.join('\n')).toMatch(/unknown action "no.such"/);
    expect(r).toMatchObject({ outcome: 'to_developer', attempts: 2 });
  });
});

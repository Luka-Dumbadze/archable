// packages/architect/src/evals.ts: eval cases (v3 §6.2) and how one runs. A case is a few customer turns played
// against a pinned bundle, then assertions: a tool was called, and judged questions that Jev answers as Booleans
// over the transcript and the tools' results (the evidence, as at pre-send), so a run doesn't depend on the model
// under test (v3 §6.2).
import YAML from 'yaml';
import { z } from 'zod';

const Judge = z.strictObject({ question: z.string().min(8), min: z.number().min(0).max(1).optional(), max: z.number().min(0).max(1).optional() })
  .refine((j) => (j.min === undefined) !== (j.max === undefined), 'a judge needs exactly one of min, max');
const Expect = z.union([z.strictObject({ tool_called: z.string() }), z.strictObject({ judge: Judge })]);

export const EvalCase = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  desire: z.string().regex(/^D-\d+$/).optional(),
  turns: z.array(z.strictObject({ customer: z.string().min(1) })).min(1).max(6),
  expect: z.array(Expect).min(1),
  fixtures: z.strictObject({
    customer: z.strictObject({ phone: z.string(), name: z.string().optional(), age_verified: z.boolean().optional() }).optional(),
  }).optional(),
});
export type EvalCase = z.infer<typeof EvalCase>;

export function parseCase(yaml: string): EvalCase {
  return EvalCase.parse(YAML.parse(yaml));
}

/** Where a case runs: one host per pinned bundle and eval environment (see eval-host.ts). */
export interface EvalHost {
  customer(fixture: NonNullable<NonNullable<EvalCase['fixtures']>['customer']>): Promise<string>;
  turn(conversationKey: string, text: string, customerId: string | null): Promise<{ turnId: string; text: string; allowed: boolean; evidence: string[] }>;
  toolsCalled(turnIds: string[]): Promise<string[]>;
  judge(state: Record<string, string>, questions: Record<string, string>): Promise<Record<string, number>>;   // P(true)
}

export interface RunResult { pass: boolean; failures: string[]; transcript: string }
export interface CaseResult { id: string; passes: number; runs: number; results: RunResult[] }

export async function runOnce(host: EvalHost, c: EvalCase, key: string): Promise<RunResult> {
  const customerId = c.fixtures?.customer ? await host.customer(c.fixtures.customer) : null;
  const lines: string[] = [];
  const evidence: string[] = [];
  const blocked: string[] = [];
  const turnIds: string[] = [];
  for (const t of c.turns) {
    const r = await host.turn(key, t.customer, customerId);
    turnIds.push(r.turnId);
    lines.push(`customer: ${t.customer}`, `agent: ${r.text}`);
    if (!r.allowed) blocked.push(`turn ${turnIds.length}: the draft was not sent (pre-send check); the holding reply went out`);
    evidence.push(...r.evidence);
  }
  const transcript = lines.join('\n');
  const failures: string[] = [];
  const called = new Set(await host.toolsCalled(turnIds));
  const judges = c.expect.flatMap((e, i) => ('judge' in e ? [[`q${i}`, e.judge] as const] : []));
  const p = judges.length
    ? await host.judge({ transcript, evidence: evidence.join('\n') || '(no tool was called)' }, Object.fromEntries(judges.map(([id, j]) => [id, j.question])))
    : {};
  c.expect.forEach((e, i) => {
    if ('tool_called' in e) {
      if (!called.has(e.tool_called)) failures.push(`${e.tool_called} was not called`);
      return;
    }
    const v = p[`q${i}`];
    if (v === undefined) failures.push(`no answer for "${e.judge.question}"`);
    else if (e.judge.min !== undefined && v < e.judge.min) failures.push(`"${e.judge.question}" P=${v.toFixed(2)} < ${e.judge.min}`);
    else if (e.judge.max !== undefined && v > e.judge.max) failures.push(`"${e.judge.question}" P=${v.toFixed(2)} > ${e.judge.max}`);
  });
  return { pass: failures.length === 0, failures: failures.length ? [...failures, ...blocked] : failures, transcript };
}

export async function runCase(host: EvalHost, c: EvalCase, runs: number, keyPrefix: string): Promise<CaseResult> {
  const results: RunResult[] = [];
  for (let i = 0; i < runs; i++) results.push(await runOnce(host, c, `${keyPrefix}_${c.id}_${i}`));
  return { id: c.id, passes: results.filter((r) => r.pass).length, runs, results };
}

/** Wilson score lower bound at 95 %: the suite gate `{ wilson_lb }` (v3 §4.3). */
export function wilsonLower(passes: number, runs: number, z = 1.96): number {
  if (runs === 0) return 0;
  const p = passes / runs;
  const d = 1 + (z * z) / runs;
  return (p + (z * z) / (2 * runs) - z * Math.sqrt((p * (1 - p)) / runs + (z * z) / (4 * runs * runs))) / d;
}

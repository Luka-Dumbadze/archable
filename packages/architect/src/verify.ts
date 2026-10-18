// packages/architect/src/verify.ts: archable/verify's eval part (v3 §3.7, §7.2). The fail-to-pass case must pass on
// the head; the selected suites must still pass (pass-to-pass) under their gates.
// tests(Δ) = smoke ∪ {suites with an `evaluates` link into Δ ∪ Run(Δ)} ∪ {the desire's fail-to-pass case}
//            ∪ {sealed holdouts when tier ≥ T2}.
// The graph has no `evaluates` edges yet and sealed holdouts live outside the tenant repo (v3 §4.8), so both are
// reported as not run; nothing claims a pass it didn't observe.
import type { BlastRadius, Bundle } from '@archable/compiler';
import { parseCase, runCase, wilsonLower, type CaseResult, type EvalCase, type EvalHost } from './evals';

type Gate = 'all_pass' | { wilson_lb: number };
interface SuiteDef { path?: string; runs?: number; gate?: Gate; source?: string; from_tier?: string }

export interface Selection { suite: string; cases: EvalCase[]; runs: number; gate: Gate }

export interface Verification {
  failToPass: boolean;
  passToPass: boolean;
  suites: Record<string, { passes: number; runs: number; wilson_lb: number; gate: Gate; ok: boolean; cases: CaseResult[] }>;
  new_cases: number;
  elva_drift: 'unknown';
  notRun: string[];
}

export function selectTests(head: { bundle: Bundle; files: Record<string, string> }, radius: Pick<BlastRadius, 'tier'>,
                            failing: { suite: string; case: EvalCase }): { selected: Selection[]; notRun: string[] } {
  const suites = (head.bundle.evals as { suites: Record<string, SuiteDef> }).suites;
  const casesIn = (suite: string) => {
    const dir = suites[suite]?.path;
    return dir ? Object.entries(head.files).filter(([p]) => p.startsWith(`${dir}/`) && /\.ya?ml$/.test(p)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, y]) => parseCase(y)) : [];
  };
  const selected: Selection[] = [];
  const smoke = suites.smoke;
  if (smoke?.path) selected.push({ suite: 'smoke', cases: casesIn('smoke'), runs: smoke.runs ?? 1, gate: smoke.gate ?? 'all_pass' });
  const f = suites[failing.suite];
  selected.push({ suite: failing.suite, cases: [failing.case], runs: f?.runs ?? 1, gate: f?.gate ?? 'all_pass' });
  const notRun = ['suites linked by evaluates edges (the graph has none yet)'];
  const sealed = Object.entries(suites).find(([, s]) => s.source === 'platform');
  if (sealed && radius.tier >= Number(String(sealed[1].from_tier ?? 'T2').slice(1))) notRun.push(`${sealed[0]}: sealed holdouts (platform, not in this repo)`);
  return { selected, notRun };
}

export async function verify(host: EvalHost, sel: { selected: Selection[]; notRun: string[] }, failingId: string, keyPrefix: string): Promise<Verification> {
  const suites: Verification['suites'] = {};
  let failToPass = false;
  for (const s of sel.selected) {
    const cases: CaseResult[] = [];
    for (const c of s.cases) cases.push(await runCase(host, c, s.runs, `${keyPrefix}_${s.suite}`));
    const passes = cases.reduce((a, c) => a + c.passes, 0);
    const runs = cases.reduce((a, c) => a + c.runs, 0);
    const lb = wilsonLower(passes, runs);
    const ok = s.gate === 'all_pass' ? passes === runs : lb >= s.gate.wilson_lb;
    suites[s.suite] = { passes, runs, wilson_lb: Number(lb.toFixed(3)), gate: s.gate, ok, cases };
    const f = cases.find((c) => c.id === failingId);
    if (f) failToPass = s.gate === 'all_pass' ? f.passes === f.runs : wilsonLower(f.passes, f.runs) >= s.gate.wilson_lb;
  }
  return { failToPass, passToPass: Object.values(suites).every((s) => s.ok), suites, new_cases: 1, elva_drift: 'unknown', notRun: sel.notRun };
}

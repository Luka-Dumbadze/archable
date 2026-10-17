// scripts/calibrate.ts: runs evals/calibration/pre_send.yaml through Jev and reports, per script and head, where
// labelled-true and labelled-false replies separate (v3 §1.1: thresholds come from our own labelled turns).
//   TYPESAFE_API_KEY=… pnpm tsx scripts/calibrate.ts [--tenant marani] [--runs 2]
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { experimental_decide as decide } from 'ai';
import YAML from 'yaml';
import { typesafeDecisionModel } from '../packages/runtime/src/typesafe';

const { values } = parseArgs({ options: { tenant: { type: 'string', default: 'marani' }, runs: { type: 'string', default: '2' } } });
const root = `fixtures/${values.tenant}`;
const set = YAML.parse(readFileSync(`${root}/evals/calibration/pre_send.yaml`, 'utf8')) as {
  customer_message: string; evidence: unknown;
  cases: { id: string; label: { grounded: boolean; commitment: boolean }; reply: Record<string, string> }[];
};
const spec = YAML.parse(readFileSync(`${root}/enterprise.spec.yaml`, 'utf8'));
const heads = { grounded: spec.decisions['send.grounded'], commitment: spec.decisions['send.commitment'] };
const model = typesafeDecisionModel({ apiKey: process.env.TYPESAFE_API_KEY! });

type Row = { id: string; script: string; truth: { grounded: boolean; commitment: boolean }; grounded: number[]; commitment: number[] };
const rows: Row[] = [];
for (const c of set.cases) {
  for (const [script, reply] of Object.entries(c.reply)) {
    const row: Row = { id: c.id, script, truth: c.label, grounded: [], commitment: [] };
    for (let i = 0; i < Number(values.runs); i++) {
      const r = await decide({ model, maxRetries: 1, state: { reply, evidence: set.evidence, customer_message: set.customer_message } as never, questions: {
        grounded: { type: 'boolean', instructions: heads.grounded.instructions },
        commitment: { type: 'boolean', instructions: heads.commitment.instructions },
      } });
      row.grounded.push(r.answers.grounded.probability);
      row.commitment.push(r.answers.commitment.probability);
    }
    rows.push(row);
  }
}

const f = (x: number) => x.toFixed(2);
const span = (xs: number[]) => (Math.min(...xs) === Math.max(...xs) ? f(xs[0]!) : `${f(Math.min(...xs))}–${f(Math.max(...xs))}`);
console.log(`${'case'.padEnd(18)} ${'script'.padEnd(9)} grounded (truth)    commitment (truth)`);
for (const r of rows) {
  console.log(`${r.id.padEnd(18)} ${r.script.padEnd(9)} ${span(r.grounded).padEnd(10)} (${r.truth.grounded ? 'true ' : 'false'})    ${span(r.commitment).padEnd(10)} (${r.truth.commitment ? 'true' : 'false'})`);
}

console.log('\nSeparation per script: lowest score of a labelled-true reply vs highest of a labelled-false one.');
const scripts = [...new Set(rows.map((r) => r.script))];
for (const head of ['grounded', 'commitment'] as const) {
  for (const s of [...scripts, 'all']) {
    const rs = rows.filter((r) => s === 'all' || r.script === s);
    const yes = rs.filter((r) => r.truth[head]).flatMap((r) => r[head]);
    const no = rs.filter((r) => !r.truth[head]).flatMap((r) => r[head]);
    const gap = Math.min(...yes) - Math.max(...no);
    console.log(`${head.padEnd(11)} ${s.padEnd(9)} true ≥ ${f(Math.min(...yes))}   false ≤ ${f(Math.max(...no))}   ${gap > 0 ? `separated, gap ${f(gap)}` : `OVERLAP ${f(-gap)}`}`);
  }
}
const g = heads.grounded, c = heads.commitment;
const passG = (r: Row) => r.grounded.every((p) => p >= g.pass_at && !(g.escalate?.probability_between && p >= g.escalate.probability_between[0] && p <= g.escalate.probability_between[1]));
const passC = (r: Row) => r.commitment.every((p) => p < c.block_at && !(c.escalate?.probability_between && p >= c.escalate.probability_between[0] && p <= c.escalate.probability_between[1]));
console.log(`\nWith the spec's thresholds (grounded pass_at ${g.pass_at}, band ${JSON.stringify(g.escalate?.probability_between)}; commitment block_at ${c.block_at}, band ${JSON.stringify(c.escalate?.probability_between)}), no fallback:`);
for (const s of scripts) {
  const rs = rows.filter((r) => r.script === s);
  const sent = rs.filter((r) => passG(r) && passC(r));
  const right = sent.filter((r) => r.truth.grounded && !r.truth.commitment).length;
  console.log(`  ${s.padEnd(9)} sent ${sent.length}/${rs.length}: ${right} correct replies sent of ${rs.filter((r) => r.truth.grounded && !r.truth.commitment).length}; ${sent.length - right} false replies sent`);
}

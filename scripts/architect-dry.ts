// scripts/architect-dry.ts: the Architect loop without GitHub (plan §7.8).
//   pnpm tsx scripts/architect-dry.ts --tenant marani --say "customers want to pay the courier in cash, up to 300 lari" [--keep]
// Owner text → desire (intake) → failing eval case (reproduce) → ChangeSet (patch) → compile → blast radius → evals in
// the preview environment pr-0 → rationale card. Nothing is pushed. Afterwards the eval rows, the candidate bundles
// and (without --keep) the desire are deleted.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';
import YAML from 'yaml';
import { compile, type Bundle } from '@archable/compiler';
import { typesafeDecisionModel } from '../packages/runtime/src/index';
import { controlDb, runtimeDb, withTenant } from '../apps/api/src/db';
import { createLanguageModels, createTurnEngine } from '../apps/api/src/turn-wiring';
import { closeEvalEnv, desireStore, draftPatch, evalHost, heal, intake, openEvalEnv, reproduce, runOnce, selectTests, verify,
         type Lane } from '../packages/architect/src/index';
import { boundsFor, buildChangeRationale, labelsFrom, rationaleDigest, renderOps, renderRationale, witnesses } from '../packages/governance/src/index';

const { values } = parseArgs({ options: { tenant: { type: 'string', default: 'marani' }, say: { type: 'string' }, keep: { type: 'boolean', default: false } } });
const slug = values.tenant!, text = values.say;
if (!text) throw new Error('--say "<what the owner asks for>" is required');
if (!process.env.TYPESAFE_API_KEY) throw new Error('set TYPESAFE_API_KEY (Jev decides intake and judges the evals)');

const out = (s: string) => console.log(s);
const ROOT = `fixtures/${slug}`;
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const files = Object.fromEntries(walk(ROOT).map((p) => [relative(ROOT, p).split(sep).join('/'), readFileSync(p, 'utf8').replace(/\r\n/g, '\n')]));
const lock = YAML.parse(files['archable.lock']!);
const base = compile({ files }, lock);
const h = createHash('sha256').update(`archable:tenant:${slug}`).digest('hex');
const tenantId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;

const [t] = await withTenant(controlDb, tenantId, (tx) => tx<{ active_digest: string | null }[]>`select active_digest from public.tenants where id = ${tenantId}`);
if (!t || t.active_digest !== base.digest) {
  throw new Error(`${ROOT} compiles to ${base.digest}, but ${slug}'s active bundle is ${t?.active_digest ?? 'none'}: run scripts/seed-marani.ts first`);
}

const models = createLanguageModels();
const jev = typesafeDecisionModel({ apiKey: process.env.TYPESAFE_API_KEY });
const laneOf = (l: Bundle['models'][keyof Bundle['models']]): Lane => ({ model: models(l.model), ...(l.reasoning ? { reasoning: l.reasoning } : {}) });
const patchLane = laneOf(base.bundle.models.patch);
const store = desireStore(controlDb);
const spec = YAML.parse(files['enterprise.spec.yaml']!) as { governance: { architect: { max_patch_attempts: number } } };
const env = 'pr-0' as const;                                     // the dry run's preview environment: no PR number
const turnIds: string[] = [];
const registered: string[] = [];
const host = (digest: string, bundle: Bundle) => {
  const observed = new Map<string, { tool: string; output: Record<string, unknown> }[]>();
  const observe = (turnId: string | null, tool: string, output: Record<string, unknown>) => {
    if (turnId) observed.set(turnId, [...(observed.get(turnId) ?? []), { tool, output }]);
  };
  return evalHost({ control: controlDb, tenantId, env, digest, bundle, observed, judgeModel: jev, turnIds,
                    handleTurn: createTurnEngine({ pinned: { env, digest, bundle }, observe }) });
};

// 1. Intake.
const at = new Date().toISOString();
const r = await intake({ jev, lane: laneOf(base.bundle.models.dialogue), store }, { tenantId, text, at });
if (r.outcome === 'not_a_change') {
  out(`→ not a change request: ${r.intent} (p ${r.p.toFixed(2)})`);
  await controlDb.end(); await runtimeDb.end();
  process.exit(0);
}
const d = r.desire;
out(`→ D-${d.number} ${r.outcome} · “${d.statement}” (intent change, p ${r.p.toFixed(2)})`);
const brief = { number: d.number, statement: d.statement, evidence: [`owner, ${at}: ${text}`] };

try {
  // 2. Reproduce: the case must fail on the active bundle.
  const agent = Object.values(base.bundle.apps).map((a) => a.agent).find((a) => a && base.bundle.agents[a])!;
  const failing = await reproduce(patchLane, brief, base.bundle.agents[agent]!.persona);
  await openEvalEnv(controlDb, { tenantId, env, gitSha: 'dry-run', compiler: lock.compiler, bundles: [], seedDigest: base.digest, files });
  const onBase = await runOnce(host(base.digest, base.bundle), failing.case, 'dry_base');
  out(`→ ${failing.id}: ${failing.case.turns.map((x) => `“${x.customer}”`).join(' / ')}`);
  if (onBase.pass) {
    out('→ the case passes on the active bundle: no spec gap. The desire goes to the developer as an observation.');
  } else {
    out(`→ reproduced: fails on the active bundle (${onBase.failures.join('; ')})`);

    // 3. Patch → compile → verify, up to max_patch_attempts.
    const result = await heal({
      desire: brief, base: { files, lock, bundle: base.bundle, digest: base.digest },
      failing: { suite: 'regressions', id: failing.id, yaml: failing.yaml, case: failing.case },
      maxAttempts: spec.governance.architect.max_patch_attempts,
      draft: (feedback) => draftPatch(patchLane, { desire: brief, failingCase: failing.yaml, files, feedback }, base.digest),
      verify: async (head, radius) => {
        const o = await openEvalEnv(controlDb, { tenantId, env, gitSha: 'dry-run', compiler: lock.compiler, seedDigest: base.digest, files: head.files,
          bundles: [{ digest: head.digest, bundle: head.bundle, projections: head.projections }] });
        registered.push(...o.inserted);
        return verify(host(head.digest, head.bundle), selectTests(head, radius, { suite: 'regressions', case: failing.case }),
                      failing.id, `dry_${head.digest.slice(7, 15)}`);
      },
      log: (event, data) => console.error(JSON.stringify({ event, ...data })),
    });

    if (result.outcome === 'to_developer') {
      out(`→ ${result.attempts} attempts failed; the desire goes to the developer with the failing case.`);
      for (const f of result.feedback) out(`  ${f.replace(/\n/g, '\n    ')}`);   // what the developer receives
    } else {
      const { changeset: cs, head, radius, verification: v } = result;
      const suites = Object.values(v.suites);
      const passes = suites.reduce((a, s) => a + s.passes, 0), runs = suites.reduce((a, s) => a + s.runs, 0);
      const floors = [...new Set(witnesses(radius).map((x) => x.rule).filter((x) => x in base.bundle.risk.floors))];
      out(`→ D-${d.number} · ChangeSet (${cs.ops.length} ops) · compile ok · tier T${radius.tier} (${floors.join(', ')}) · `
        + `fail-to-pass ${v.failToPass ? '✓' : '✗'} · ${passes}/${runs}`);
      for (const op of cs.ops) out(`    ${op.op} ${'path' in op ? op.path : 'id' in op ? op.id : 'agent' in op ? op.agent : 'object' in op ? `${op.object}.${op.field}` : ''}`);
      for (const [name, s] of Object.entries(v.suites)) out(`    ${name}: ${s.passes}/${s.runs}${s.gate === 'all_pass' ? '' : ` (Wilson ${s.wilson_lb})`}`);
      for (const n of v.notRun) out(`    not run: ${n}`);

      // 4. The rationale card for this head (plan §7.5), from the same facts the verify job would freeze.
      const [row] = await withTenant(controlDb, tenantId, (tx) => tx<{ chapters: number; customers: number; quoted: number; abandoned: number;
        abandoned_value: string; ordered: number; first_seen: Date | null; last_seen: Date | null }[]>`
        select * from public.desire_impact(${tenantId}, ${d.id}, interval '2 hours')`);
      const card = buildChangeRationale({
        changeRequestId: 'dry-run', desire: { number: d.number, source: d.source, statement: d.statement }, ownerRequest: { at, text },
        headSha: 'dry-run', quietHours: 2, reasons: witnesses(radius), bounds: boundsFor(head.bundle, radius), ops: renderOps(cs.ops, head.bundle),
        impact: { ...row!, abandoned_value: Number(row!.abandoned_value), first_seen: row!.first_seen?.toISOString() ?? null, last_seen: row!.last_seen?.toISOString() ?? null },
        verification: { suites: Object.fromEntries(Object.entries(v.suites).map(([k, s]) => [k, { passes: s.passes, runs: s.runs }])), new_cases: v.new_cases, elva_drift: v.elva_drift },
        labels: labelsFrom(head.bundle, base.bundle), now: new Date().toISOString(),
      });
      out(`\n${renderRationale(card)}\n\nrationale digest ${rationaleDigest(card)} · head bundle ${head.digest} · nothing pushed`);
    }
  }
} finally {
  await closeEvalEnv(controlDb, { tenantId, env, turnIds, unregister: registered });
  if (!values.keep && r.outcome === 'opened') await store.remove(tenantId, d.id);
  await controlDb.end();
  await runtimeDb.end();
}

// packages/architect/src/reverify.ts: the 'verify' queue's job (v3 §7.2 Verify, §3.7): a head pushed to an
// Architect PR (a developer's commit, or an update-branch) is verified like the Architect's own: compile, blast
// radius against main, the selected suites in the PR's preview env pr-<n>, archable/verify, the preview bundle,
// and a re-frozen rationale card. The fail-to-pass set is the desire's regression cases in the head tree.
import { blastRadius, compile, CompileFailure, digestOf, type Lock } from '@archable/compiler';
import type { Env } from '@archable/contracts';
import { freezeRationale, postCheck, treeAt, type TenantRepo } from '@archable/governance';
import type { ChangeSet } from '@archable/schema';
import type postgres from 'postgres';
import YAML from 'yaml';
import type { z } from 'zod';
import type { AuthorDeps } from './author';
import { closeEvalEnv, evalHost, openEvalEnv, type HostDeps } from './eval-host';
import { parseCase, runCase, wilsonLower } from './evals';

type Tx = postgres.TransactionSql;
export interface VerifyJob { kind: 'verify'; tenant_id: string; change_request_id: string }
export type VerifyJobOutcome =
  | { outcome: 'verified'; tier: number; passes: number; runs: number }
  | { outcome: 'failed'; reason: string }
  | { outcome: 'skipped'; reason: string };

export async function runVerifyJob(d: AuthorDeps, job: VerifyJob): Promise<VerifyJobOutcome> {
  const tenantId = job.tenant_id;
  const inT = <T>(fn: (tx: Tx) => Promise<T>) =>
    d.control.begin(async (tx) => { await tx`select set_config('app.tenant_id', ${tenantId}, true)`; return fn(tx); }) as Promise<T>;
  const s = await inT(async (tx) => {
    const [t] = await tx<{ installation_id: string | null; repo_full_name: string | null }[]>`select installation_id, repo_full_name from public.tenants where id = ${tenantId}`;
    const [cr] = await tx<{ id: string; pr_number: number; head_sha: string; desire_id: string | null; state: string }[]>`
      select id, pr_number, head_sha, desire_id, state from public.change_requests where tenant_id = ${tenantId} and id = ${job.change_request_id}`;
    const [desire] = cr?.desire_id ? await tx<{ number: number; statement: string; source: 'owner_request' | 'failure_cluster' | 'developer_note' | 'kpi_drift';
      changeset: z.infer<typeof ChangeSet> | null }[]>`select number, statement, source, changeset from public.desires where tenant_id = ${tenantId} and id = ${cr.desire_id}` : [];
    return { t, cr, desire };
  });
  if (!s.cr) return { outcome: 'skipped', reason: 'change not found' };
  if (['merging', 'merged', 'closed', 'superseded'].includes(s.cr.state)) return { outcome: 'skipped', reason: `change is ${s.cr.state}` };
  const [owner, name] = (s.t?.repo_full_name ?? '').split('/');
  if (!s.t?.installation_id || !owner || !name) return { outcome: 'skipped', reason: 'no repository' };
  const repo: TenantRepo = { installationId: Number(s.t.installation_id), owner, repo: name };
  const fail = async (reason: string) => {
    await postCheck(d.app, repo, { name: 'archable/verify', headSha: s.cr!.head_sha, state: 'failure', title: reason, summary: reason });
    await inT((tx) => tx`update public.change_requests set state = 'failed', updated_at = now() where tenant_id = ${tenantId} and id = ${s.cr!.id}`);
    return { outcome: 'failed' as const, reason };
  };

  const gh = await d.app.getInstallationOctokit(repo.installationId);
  const { data: main } = await gh.rest.git.getRef({ owner, repo: name, ref: 'heads/main' });
  const [baseFiles, headFiles] = [await treeAt(d.app, repo, main.object.sha), await treeAt(d.app, repo, s.cr.head_sha)];
  const lockOf = (f: Record<string, string>) => YAML.parse(f['archable.lock'] ?? '') as Lock;
  let base, head;
  try { base = compile({ files: baseFiles }, lockOf(baseFiles)); head = compile({ files: headFiles }, lockOf(headFiles)); } catch (e) {
    if (!(e instanceof CompileFailure)) throw e;
    return fail(`Does not compile: ${e.errors.slice(0, 3).map((x) => x.message).join('; ')}`);
  }
  const radius = blastRadius(base.bundle.graph, head.bundle.graph, base.bundle.risk);

  // Selected suites: smoke, plus the desire's regression cases (fail-to-pass), with their runs and gates.
  const suites = (head.bundle.evals as { suites: Record<string, { path?: string; runs?: number; gate?: 'all_pass' | { wilson_lb: number } }> }).suites;
  const casesIn = (suite: string, only?: (id: string) => boolean) => Object.entries(headFiles)
    .filter(([p]) => suites[suite]?.path && p.startsWith(`${suites[suite]!.path}/`) && /\.ya?ml$/.test(p)).map(([, y]) => parseCase(y))
    .filter((c) => !only || only(c.id));
  const desireTag = s.desire ? `D-${s.desire.number}` : null;
  const selected = [
    { suite: 'smoke', cases: casesIn('smoke') },
    { suite: 'regressions', cases: casesIn('regressions', (id) => !!desireTag && id.startsWith(`d-${s.desire!.number}-`)) },
  ].filter((x) => x.cases.length);

  const env = `pr-${s.cr.pr_number}` as Env;                                  // the PR's own preview env
  const turnIds: string[] = [];
  const opened = await openEvalEnv(d.control, { tenantId, env, gitSha: s.cr.head_sha, compiler: lockOf(headFiles).compiler, seedDigest: head.digest, files: headFiles,
    bundles: [{ digest: head.digest, bundle: head.bundle, projections: head.projections }] });
  const results: Record<string, { passes: number; runs: number; ok: boolean }> = {};
  try {
    const observed: HostDeps['observed'] = new Map();
    const host = evalHost({ control: d.control, tenantId, env, digest: head.digest, bundle: head.bundle, observed, judgeModel: d.jev, turnIds,
      handleTurn: d.engine({ env, digest: head.digest, bundle: head.bundle }, (turnId, tool, output) => {
        if (turnId) observed.set(turnId, [...(observed.get(turnId) ?? []), { tool, output }]);
      }) });
    for (const sel of selected) {
      const runs = suites[sel.suite]?.runs ?? 1, gate = suites[sel.suite]?.gate ?? 'all_pass';
      let passes = 0, total = 0;
      for (const c of sel.cases) { const r = await runCase(host, c, runs, `verify_${s.cr.pr_number}_${sel.suite}`); passes += r.passes; total += r.runs; }
      results[sel.suite] = { passes, runs: total, ok: gate === 'all_pass' ? passes === total : wilsonLower(passes, total) >= gate.wilson_lb };
    }
  } finally {
    await closeEvalEnv(d.control, { tenantId, env, turnIds, unregister: opened.inserted });
  }
  const passes = Object.values(results).reduce((a, r) => a + r.passes, 0), runs = Object.values(results).reduce((a, r) => a + r.runs, 0);
  const line = Object.entries(results).map(([k, r]) => `${k} ${r.passes}/${r.runs}`).join(', ') || 'no cases selected';
  if (!Object.values(results).every((r) => r.ok)) return fail(`T${radius.tier} · ${line}`);

  const deltaDigest = digestOf(radius.changed.map((id) => [id, head.bundle.graph.nodes.find((n) => n.id === id)?.hash ?? null]));
  await inT(async (tx) => {
    await tx`insert into public.specs (tenant_id, digest, git_sha, compiler_version, bundle, state, verified_at)
             values (${tenantId}, ${head.digest}, ${s.cr!.head_sha}, ${lockOf(headFiles).compiler}, ${tx.json(head.bundle as never)}, 'preview', now())
             on conflict (tenant_id, digest) do update set verified_at = coalesce(public.specs.verified_at, now())`;
    for (const e of head.projections.entitySchemas) await tx`insert into public.entity_schemas ${tx({ tenant_id: tenantId, spec_digest: head.digest, ...e } as never)} on conflict do nothing`;
    for (const a of head.projections.apps) await tx`insert into public.apps ${tx({ tenant_id: tenantId, spec_digest: head.digest, ...a } as never)} on conflict do nothing`;
    await tx`update public.change_requests set bundle_digest = ${head.digest}, delta_digest = ${deltaDigest}, tier = ${radius.tier}, state = 'verifying',
      blast_radius = ${tx.json({ changed: radius.changed, reached: radius.reached, why: radius.why } as never)},
      verification = ${tx.json({ suites: results, elva_drift: 'unknown' } as never)}, updated_at = now()
      where tenant_id = ${tenantId} and id = ${s.cr!.id}`;
    if (s.desire) {
      await freezeRationale(tx, { tenant_id: tenantId, id: s.cr!.id, desire_id: s.cr!.desire_id, head_sha: s.cr!.head_sha }, {
        desire: { number: s.desire.number, source: s.desire.source, statement: s.desire.statement },
        radius: { changed: radius.changed, reached: radius.reached, why: radius.why },
        changeset: s.desire.changeset ?? { desire: desireTag!, base_digest: base.digest, rationale: '', ops: [] as never },
        verification: { suites: Object.fromEntries(Object.entries(results).map(([k, r]) => [k, { passes: r.passes, runs: r.runs }])), new_cases: 0, elva_drift: 'unknown' },
      }, head.bundle, base.bundle);
    }
  });
  await postCheck(d.app, repo, { name: 'archable/verify', headSha: s.cr.head_sha, state: 'success', title: `T${radius.tier} · ${line}`,
                                 summary: `Compiled to ${head.digest}. ${line}.` });
  return { outcome: 'verified', tier: radius.tier, passes, runs };
}

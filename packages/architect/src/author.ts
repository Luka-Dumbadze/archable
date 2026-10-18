// packages/architect/src/author.ts: the 'architect' queue's draft job (v3 §7.2, plan §7.8 "for real"). A desire the
// owner confirmed with Draft it goes through draftChange on the tenant repo's main; a ready change becomes a PR on
// archable/d-<n> with its head registered as a verified preview, a change_requests row, archable/verify, the frozen
// rationale card and, when only the owner is still needed, the owner's card. Otherwise the desire goes to the developer.
import { compile, CompileFailure, digestOf, type Lock } from '@archable/compiler';
import { evaluateApproval, freezeRationale, issueCards, openChangePR, postCheck, renderRationale, treeAt,
         type CardDeps, type TenantRepo } from '@archable/governance';
import type { App } from 'octokit';
import type postgres from 'postgres';
import YAML from 'yaml';
import { draftChange, draftEnv, type DraftDeps } from './draft';

type Tx = postgres.TransactionSql;

export interface AuthorDeps extends DraftDeps {
  app: App;
  send?: CardDeps['send'];                           // the owner's card (DEV-1's Telegram sender); absent: no card yet
}

export interface DraftJob { kind: 'draft'; tenant_id: string; desire_id: string }
export type DraftJobOutcome =
  | { outcome: 'opened'; prNumber: number; tier: number; changeRequestId: string; card: string }
  | { outcome: 'skipped' | 'no_repo'; reason: string }
  | { outcome: 'to_developer'; reason: string }
  | { outcome: 'base_moved'; retry: true };

interface DesireRow { id: string; number: number; statement: string; source: 'owner_request' | 'failure_cluster' | 'developer_note' | 'kpi_drift';
                      status: string; evidence: { kind?: string; at?: string; text?: string }[] }

export async function runDraftJob(d: AuthorDeps, job: DraftJob): Promise<DraftJobOutcome> {
  const tenantId = job.tenant_id;
  const inT = <T>(fn: (tx: Tx) => Promise<T>) =>
    d.control.begin(async (tx) => { await tx`select set_config('app.tenant_id', ${tenantId}, true)`; return fn(tx); }) as Promise<T>;
  const { t, desire, hasDeveloper } = await inT(async (tx) => {
    const [t] = await tx<{ slug: string; installation_id: string | null; repo_full_name: string | null }[]>`
      select slug, installation_id, repo_full_name from public.tenants where id = ${tenantId}`;
    const [desire] = await tx<DesireRow[]>`select id, number, statement, source, status, evidence from public.desires
      where tenant_id = ${tenantId} and id = ${job.desire_id}`;
    const [dev] = await tx<{ n: number }[]>`select count(*)::int as n from public.memberships where tenant_id = ${tenantId} and role = 'developer' and revoked_at is null`;
    return { t, desire, hasDeveloper: dev!.n > 0 };
  });
  if (!desire) return { outcome: 'skipped', reason: 'desire not found' };
  if (desire.status !== 'drafting') return { outcome: 'skipped', reason: `desire is ${desire.status}` };   // a retried job after the PR
  const [owner, name] = (t?.repo_full_name ?? '').split('/');
  if (!t?.installation_id || !owner || !name) return { outcome: 'no_repo', reason: 'the tenant has no GitHub repository yet' };
  const repo: TenantRepo = { installationId: Number(t.installation_id), owner, repo: name };
  const toDeveloper = async (reason: string, note: object) => {
    await inT((tx) => tx`update public.desires set status = 'open', assignee = 'developer', updated_at = now(),
      evidence = evidence || ${tx.json([{ kind: 'architect', at: new Date().toISOString(), ...note }] as never)}
      where tenant_id = ${tenantId} and id = ${desire.id}`);
    return { outcome: 'to_developer' as const, reason };
  };

  // The base is what the tenant repo's main holds.
  const gh = await d.app.getInstallationOctokit(repo.installationId);
  const { data: ref } = await gh.rest.git.getRef({ owner, repo: name, ref: 'heads/main' });
  const files = await treeAt(d.app, repo, ref.object.sha);
  const lock = YAML.parse(files['archable.lock'] ?? '') as Lock;
  let compiled;
  try { compiled = compile({ files }, lock); } catch (e) {
    if (!(e instanceof CompileFailure)) throw e;
    return toDeveloper('main does not compile', { compile: e.errors.map((x) => x.message) });
  }
  const evidence = desire.evidence.filter((e) => e.text).map((e) => `${e.kind ?? 'evidence'}, ${e.at ?? ''}: ${e.text}`);
  const brief = { number: desire.number, statement: desire.statement, evidence };
  const r = await draftChange(d, { tenantId, desire: brief, base: { files, lock, compiled, gitSha: ref.object.sha }, env: draftEnv(desire.number) });
  if (r.outcome === 'no_gap') return toDeveloper('the case passes on main: no spec gap', { case: r.failing.yaml });
  if (r.outcome === 'to_developer') return toDeveloper(`${r.attempts} attempts failed`, { case: r.failing.yaml, feedback: r.feedback });

  // The PR: only the files the ChangeSet changed.
  const { head, radius, verification: v, changeset } = r;
  const changed = Object.entries(head.files).filter(([p, c]) => files[p] !== c).map(([path, content]) => ({ path, content }));
  const suites = Object.entries(v.suites).map(([k, s]) => `${k} ${s.passes}/${s.runs}`).join(', ');
  const pr = await openChangePR(d.app, repo, {
    branch: `archable/d-${desire.number}`, title: `${desire.statement} (D-${desire.number})`, expectBaseSha: ref.object.sha, files: changed,
    message: `D-${desire.number}: ${desire.statement}\n\n${changeset.rationale}`,
    body: [`**D-${desire.number}** · ${desire.statement}`, '', `Tier **T${radius.tier}** (${[...new Set(radius.why.map((w) => w.rule))].join(', ')})`,
           `Fail-to-pass ✓ · ${suites}`, '', 'Ops:', ...changeset.ops.map((o) => `- \`${o.op}\``), '', `Evidence:`, ...evidence.map((e) => `- ${e}`)].join('\n'),
  });
  if (!pr.ok) return { outcome: 'base_moved', retry: true };

  const pending = evaluateApproval({ tier: radius.tier, headSha: pr.headSha, author: 'architect', developerReady: false, hasDeveloper,
                                     delegation: { upTo: head.bundle.governance.delegation.upTo }, ledger: [] });
  const waitingFor = pending.state === 'in_progress' ? pending.waitingFor : [];
  const ownerRequest = desire.evidence.find((e) => e.kind === 'owner_message' && e.at && e.text);
  // Δ: the changed node ids with their head hashes (v3 §8 change_requests.delta_digest); approvals bind to it (I4).
  const deltaDigest = digestOf(radius.changed.map((id) => [id, head.bundle.graph.nodes.find((n) => n.id === id)?.hash ?? null]));
  const crId = await inT(async (tx) => {
    await tx`insert into public.specs (tenant_id, digest, git_sha, compiler_version, bundle, state, verified_at)
             values (${tenantId}, ${head.digest}, ${pr.headSha}, ${lock.compiler}, ${tx.json(head.bundle as never)}, 'preview', now())
             on conflict (tenant_id, digest) do update set verified_at = coalesce(public.specs.verified_at, now())`;
    for (const e of head.projections.entitySchemas) await tx`insert into public.entity_schemas ${tx({ tenant_id: tenantId, spec_digest: head.digest, ...e } as never)} on conflict do nothing`;
    for (const a of head.projections.apps) await tx`insert into public.apps ${tx({ tenant_id: tenantId, spec_digest: head.digest, ...a } as never)} on conflict do nothing`;
    const [cr] = await tx<{ id: string }[]>`insert into public.change_requests
        (tenant_id, desire_id, pr_number, title, author_kind, model, base_sha, head_sha, delta_digest, bundle_digest, tier, blast_radius, verification, state)
      values (${tenantId}, ${desire.id}, ${pr.prNumber}, ${`${desire.statement} (D-${desire.number})`}, 'architect', ${head.bundle.models.patch.model},
              ${pr.baseSha}, ${pr.headSha}, ${deltaDigest},
              ${head.digest}, ${radius.tier}, ${tx.json({ changed: radius.changed, reached: radius.reached, why: radius.why } as never)},
              ${tx.json({ suites: v.suites, new_cases: v.new_cases, elva_drift: v.elva_drift, not_run: v.notRun } as never)},
              ${waitingFor[0] === 'developer' ? 'needs_developer' : 'needs_owner'})
      on conflict (tenant_id, pr_number) do update set head_sha = excluded.head_sha, bundle_digest = excluded.bundle_digest,
        tier = excluded.tier, blast_radius = excluded.blast_radius, verification = excluded.verification, updated_at = now()
      returning id`;
    await tx`update public.desires set status = 'in_review', changeset = ${tx.json(changeset as never)}, tier = ${radius.tier},
      affected = ${radius.changed}, updated_at = now() where tenant_id = ${tenantId} and id = ${desire.id}`;
    return cr!.id;
  });
  await postCheck(d.app, repo, { name: 'archable/verify', headSha: pr.headSha, state: 'success', title: `T${radius.tier} · fail-to-pass ✓ · ${suites}`,
                                 summary: [`Compiled to ${head.digest}.`, `Suites: ${suites}.`, ...v.notRun.map((n) => `Not run: ${n}.`)].join('\n') });
  await postCheck(d.app, repo, { name: 'archable/approval', headSha: pr.headSha, state: 'in_progress', title: pending.summary, summary: pending.summary });

  const card = await inT((tx) => freezeRationale(tx, { tenant_id: tenantId, id: crId, desire_id: desire.id, head_sha: pr.headSha }, {
    desire: { number: desire.number, source: desire.source, statement: desire.statement },
    ...(ownerRequest ? { ownerRequest: { at: ownerRequest.at!, text: ownerRequest.text! } } : {}),
    radius: { changed: radius.changed, reached: radius.reached, why: radius.why }, changeset,
    verification: { suites: Object.fromEntries(Object.entries(v.suites).map(([k, s]) => [k, { passes: s.passes, runs: s.runs }])), new_cases: v.new_cases, elva_drift: v.elva_drift },
  }, head.bundle, compiled.bundle));
  const [frozen] = await inT((tx) => tx<{ rationale_digest: string }[]>`select rationale_digest from public.change_requests where tenant_id = ${tenantId} and id = ${crId}`);

  // The owner's card now only when the owner is the one still needed (T1, or delegated); otherwise after the review.
  let cardOutcome = 'after the developer review';
  if (waitingFor.length === 1 && waitingFor[0] === 'owner') {
    if (!d.send) cardOutcome = 'no sender wired';
    else {
      const out = await issueCards({ control: d.control, send: d.send },
        { tenantId, id: crId, prNumber: pr.prNumber, headSha: pr.headSha, deltaDigest, tier: radius.tier, rationaleDigest: frozen!.rationale_digest,
          desire: { number: desire.number, statement: desire.statement } }, head.bundle, changeset.ops, { slug: t.slug });
      cardOutcome = out.map((o) => o.outcome).join(', ');
    }
  }
  d.log?.('architect.opened', { desire: desire.number, pr: pr.prNumber, tier: radius.tier, card: cardOutcome, rationale: renderRationale(card).split('\n').length });
  return { outcome: 'opened', prNumber: pr.prNumber, tier: radius.tier, changeRequestId: crId, card: cardOutcome };
}

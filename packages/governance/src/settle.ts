// packages/governance/src/settle.ts: from approval to live (plan §7.6), and Undo (v3 §4.3).
// settle is idempotent: every step checks for its effect first (the check run for this head, the PR's merge state,
// the active digest), and the move to `merging` is a compare-and-set, so a Telegram retry, a cron sweep and a
// webhook that call it together merge once and flip once.
import { compile, type Lock } from '@archable/compiler';
import type { Tier } from '@archable/contracts';
import type { App } from 'octokit';
import type postgres from 'postgres';
import YAML from 'yaml';
import { evaluateApproval, type CheckState, type LedgerRow } from './approval-check';
import { newNonce, type OpenCard } from './cards';
import { mergeApproved, postCheck, type TenantRepo } from './github';

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;
const inTenant = <T>(db: Sql, tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  db.begin(async (tx) => { await tx`select set_config('app.tenant_id', ${tenantId}, true)`; return fn(tx); }) as Promise<T>;

/** DEV-1's card edits (plan §7.3, Q9 (3)); a no-op until the API wires the Telegram sender. */
export interface CardEditor {
  reflect(cards: OpenCard[], summary: string): Promise<void>;          // "With your developer", "Rejected"
  live(cards: OpenCard[], osName: string, title: string, undoRef: string): Promise<void>;
  supersede(cards: OpenCard[], title: string): Promise<void>;
}
export const noCards: CardEditor = { reflect: async () => {}, live: async () => {}, supersede: async () => {} };

export interface SettleDeps { control: Sql; app: App; cards?: CardEditor; log?(event: string, data: Record<string, unknown>): void }

export type SettleOutcome =
  | { outcome: 'live'; digest: string; epoch: number; mergedSha: string }
  | { outcome: 'already_live' | 'busy' | 'not_found' }
  | { outcome: 'waiting' | 'rejected'; summary: string }
  | { outcome: 'head_moved' | 'not_mergeable' | 'digest_mismatch'; summary: string };

interface CrRow {
  tenant_id: string; id: string; desire_id: string | null; pr_number: number; title: string; author_kind: LedgerInput['author'];
  head_sha: string; tier: Tier; bundle_digest: string | null; state: string; merged_sha: string | null;
  blast_radius: { why?: { rule: string; path: string[] }[] } | null; updated_at: Date;
}
type LedgerInput = Parameters<typeof evaluateApproval>[0];
interface TenantRow { id: string; slug: string; os_name: string; installation_id: string | null; repo_full_name: string | null; epoch: string; active_digest: string | null }

const repoOf = (t: TenantRow): TenantRepo => {
  const [owner, repo] = (t.repo_full_name ?? '').split('/');
  if (!t.installation_id || !owner || !repo) throw new Error(`tenant ${t.slug} has no GitHub repository`);
  return { installationId: Number(t.installation_id), owner, repo };
};

/** The tree of a commit, as the compiler reads it (plan §4.3). */
export async function treeAt(app: App, t: TenantRepo, sha: string): Promise<Record<string, string>> {
  const gh = await app.getInstallationOctokit(t.installationId);
  const { data } = await gh.rest.git.getTree({ owner: t.owner, repo: t.repo, tree_sha: sha, recursive: 'true' });
  const files: Record<string, string> = {};
  for (const e of data.tree.filter((x) => x.type === 'blob' && x.path && x.sha)) {
    const b = await gh.rest.git.getBlob({ owner: t.owner, repo: t.repo, file_sha: e.sha! });
    files[e.path!] = Buffer.from(b.data.content, b.data.encoding as BufferEncoding).toString('utf8');
  }
  return files;
}

/** The governance record on the squash commit (v3 §4.2): Git alone answers "who approved what". */
export function trailersFor(cr: CrRow, ledger: (LedgerRow & { approver_label: string })[]): string {
  const why = cr.blast_radius?.why ?? [];
  const rules = [...new Set(why.map((w) => w.rule))];
  const head = cr.head_sha.slice(0, 7);
  return [
    `Archable-Tier: T${cr.tier}${rules.length ? ` (${rules.join(', ')})` : ''}`,
    ...(why[0] ? [`Archable-Witness: ${why[0].path.join(' -> ')}`] : []),
    ...(cr.bundle_digest ? [`Archable-Bundle: ${cr.bundle_digest}`] : []),
    ...ledger.filter((r) => r.status === 'approved' && r.head_sha === cr.head_sha).map((r) => r.role === 'developer'
      ? `Reviewed-by: ${r.approver_label} on ${head}`
      : `Approved-by: owner (${r.approver_label}) via ${r.channel}${r.confirm_mode === 'tap' ? '' : `+${r.confirm_mode}`} on ${head}`),
  ].join('\n');
}

const UNDO_HOURS = 24;                                   // the Live card's Undo window (Q9 (3))

export async function settle(d: SettleDeps, changeRequestId: string): Promise<SettleOutcome> {
  const log = d.log ?? (() => {});
  const cards = d.cards ?? noCards;
  const [{ tenant_id: tenantId } = { tenant_id: null }] = await d.control<{ tenant_id: string | null }[]>`
    select private.change_request_tenant(${changeRequestId}) as tenant_id`;
  if (!tenantId) return { outcome: 'not_found' };

  const load = () => inTenant(d.control, tenantId, async (tx) => {
    const [cr] = await tx<CrRow[]>`select * from public.change_requests where tenant_id = ${tenantId} and id = ${changeRequestId}`;
    const [t] = await tx<TenantRow[]>`select id, slug, os_name, installation_id, repo_full_name, epoch, active_digest from public.tenants where id = ${tenantId}`;
    const ledger = await tx<(LedgerRow & { approver_label: string })[]>`
      select a.role, a.status, a.head_sha, a.confirm_mode, a.channel,
             coalesce(m.github_login, m.display_name) || case when m.github_user_id is not null then ' (github:' || m.github_user_id || ')'
                                                              when m.tg_user_id is not null then ' (telegram)' else '' end as approver_label
        from public.approvals a join public.memberships m on m.id = a.approver
       where a.tenant_id = ${tenantId} and a.change_request_id = ${changeRequestId}`;
    const [dev] = await tx<{ n: number }[]>`select count(*)::int as n from public.memberships
      where tenant_id = ${tenantId} and role = 'developer' and revoked_at is null`;
    const [b] = cr?.bundle_digest ? await tx<{ governance: { delegation?: { upTo: Tier } } | null }[]>`
      select bundle -> 'governance' as governance from public.specs where tenant_id = ${tenantId} and digest = ${cr.bundle_digest}` : [];
    return { cr, t: t!, ledger, hasDeveloper: dev!.n > 0, delegation: b?.governance?.delegation?.upTo ?? null };
  });
  const s = await load();
  if (!s.cr) return { outcome: 'not_found' };
  if (s.cr.state === 'merged') return { outcome: 'already_live' };
  const repo = repoOf(s.t);
  const gh = await d.app.getInstallationOctokit(repo.installationId);
  const { data: pr } = await gh.rest.pulls.get({ owner: repo.owner, repo: repo.repo, pull_number: s.cr.pr_number });

  // archable/approval for this head, posted only when it changed (a repeated settle posts nothing new).
  const state: CheckState = evaluateApproval({
    tier: s.cr.tier, headSha: s.cr.head_sha, author: s.cr.author_kind, developerReady: !pr.draft,
    hasDeveloper: s.hasDeveloper, delegation: { upTo: s.delegation }, ledger: s.ledger,
  });
  const runs = await gh.rest.checks.listForRef({ owner: repo.owner, repo: repo.repo, ref: s.cr.head_sha, check_name: 'archable/approval' });
  const last = runs.data.check_runs[0];
  const posted = last && (state.state === 'in_progress' ? last.status === 'in_progress' && last.output.title === state.summary
                                                         : last.conclusion === state.state);
  if (!posted) await postCheck(d.app, repo, { name: 'archable/approval', headSha: s.cr.head_sha, state: state.state, title: state.summary, summary: state.summary });
  log('settle.check', { cr: changeRequestId, state: state.state, posted: !posted });
  if (state.state !== 'success') {
    const open = await openCards(d.control, tenantId, changeRequestId, s.cr.head_sha);
    await cards.reflect(open, state.summary);
    if (state.state === 'in_progress') {
      await inTenant(d.control, tenantId, (tx) => tx`update public.change_requests set state = ${state.waitingFor[0] === 'developer' ? 'needs_developer' : 'needs_owner'},
        updated_at = now() where tenant_id = ${tenantId} and id = ${changeRequestId} and state not in ('merging', 'merged', 'closed', 'superseded')`);
    }
    return { outcome: state.state === 'failure' ? 'rejected' : 'waiting', summary: state.summary };
  }

  // One settler at a time: the move to merging is a compare-and-set (a stale merging is resumed after 2 minutes).
  const [won] = await inTenant(d.control, tenantId, (tx) => tx<{ id: string }[]>`update public.change_requests
     set state = 'merging', updated_at = now()
   where tenant_id = ${tenantId} and id = ${changeRequestId}
     and (state in ('verifying', 'needs_developer', 'needs_owner', 'approved') or (state = 'merging' and updated_at < now() - interval '2 minutes'))
   returning id`);
  if (!won) return { outcome: 'busy' };

  let mergedSha: string;
  if (pr.merged && pr.merge_commit_sha) mergedSha = pr.merge_commit_sha;              // merged by an earlier attempt
  else {
    const m = await mergeApproved(d.app, repo, { prNumber: s.cr.pr_number, headSha: s.cr.head_sha, title: `${s.cr.title} (#${s.cr.pr_number})`,
                                                trailers: trailersFor(s.cr, s.ledger) });
    if (!m.merged) {
      await inTenant(d.control, tenantId, (tx) => tx`update public.change_requests set state = ${m.reason === 'head_moved' ? 'superseded' : 'approved'},
        updated_at = now() where tenant_id = ${tenantId} and id = ${changeRequestId}`);
      return { outcome: m.reason, summary: m.reason === 'head_moved' ? 'The change moved; it will be re-checked.' : 'GitHub refused the merge.' };
    }
    mergedSha = m.sha;
  }
  log('settle.merged', { cr: changeRequestId, sha: mergedSha });

  // Never flip to something unverified: the merge commit must compile to the digest that was verified and approved.
  const files = await treeAt(d.app, repo, mergedSha);
  const { digest } = compile({ files }, YAML.parse(files['archable.lock'] ?? '') as Lock);
  if (digest !== s.cr.bundle_digest) {
    await inTenant(d.control, tenantId, async (tx) => {
      await tx`insert into public.failures (tenant_id, kind, severity, payload) values (${tenantId}, 'eval_regression', 5,
        ${tx.json({ reason: 'merge digest differs', change_request: changeRequestId, expected: s.cr!.bundle_digest, got: digest })})`;
      await tx`update public.change_requests set state = 'failed', merged_sha = ${mergedSha}, updated_at = now() where tenant_id = ${tenantId} and id = ${changeRequestId}`;
    });
    return { outcome: 'digest_mismatch', summary: 'Merged, but not deployed: the result differs from what was checked.' };
  }

  const flip = async () => {
    const [t] = await inTenant(d.control, tenantId, (tx) => tx<{ epoch: string; active_digest: string | null }[]>`
      select epoch, active_digest from public.tenants where id = ${tenantId}`);
    if (t!.active_digest === digest) return { epoch: Number(t!.epoch), previous: null as string | null };   // already live
    const [r] = await inTenant(d.control, tenantId, (tx) => tx<{ epoch: string }[]>`select public.flip_epoch(${tenantId}, ${t!.epoch}, ${digest}) as epoch`);
    return { epoch: Number(r!.epoch), previous: t!.active_digest };
  };
  const flipped = await flip().catch(async (e) => {
    if ((e as { code?: string }).code !== '40001') throw e;                          // someone else flipped: re-read once
    return flip();
  });
  log('settle.flipped', { cr: changeRequestId, digest, epoch: flipped.epoch, previous: flipped.previous });

  const undoRef = newNonce();
  const open = await inTenant(d.control, tenantId, async (tx) => {
    await tx`update public.change_requests set state = 'merged', merged_sha = ${mergedSha}, updated_at = now() where tenant_id = ${tenantId} and id = ${changeRequestId}`;
    if (s.cr!.desire_id) await tx`update public.desires set status = 'live', updated_at = now() where tenant_id = ${tenantId} and id = ${s.cr!.desire_id}`;
    const [owner] = await tx<{ id: string }[]>`select id from public.memberships where tenant_id = ${tenantId} and role = 'owner' and revoked_at is null order by created_at limit 1`;
    if (owner && flipped.previous) {
      await tx`insert into private.owner_refs (ref, tenant_id, membership_id, action, payload, expires_at)
        values (${undoRef}, ${tenantId}, ${owner.id}, 'undo', ${tx.json({ change_request: changeRequestId, digest, previous: flipped.previous })},
                now() + make_interval(hours => ${UNDO_HOURS}))`;
    }
    return tx<{ id: string; tg_chat_id: string; tg_message_id: number }[]>`select id, tg_chat_id, tg_message_id from public.approvals
      where tenant_id = ${tenantId} and change_request_id = ${changeRequestId} and head_sha = ${s.cr!.head_sha} and role = 'owner' and tg_message_id is not null`;
  });
  await cards.live(open.map((r) => ({ approvalId: r.id, chatId: Number(r.tg_chat_id), messageId: r.tg_message_id })), s.t.os_name, s.cr.title, undoRef);
  return { outcome: 'live', digest, epoch: flipped.epoch, mergedSha };
}

async function openCards(control: Sql, tenantId: string, crId: string, headSha: string): Promise<OpenCard[]> {
  const rows = await inTenant(control, tenantId, (tx) => tx<{ id: string; tg_chat_id: string; tg_message_id: number }[]>`
    select id, tg_chat_id, tg_message_id from public.approvals where tenant_id = ${tenantId} and change_request_id = ${crId}
       and head_sha = ${headSha} and tg_message_id is not null`);
  return rows.map((r) => ({ approvalId: r.id, chatId: Number(r.tg_chat_id), messageId: r.tg_message_id }));
}

/**
 * The Live card's Undo (v3 §4.3, Q9 (3)): within 24 hours, by the owner it was issued to, back to the digest that was
 * live before. Undo is pre-authorized: that digest was approved and live already. If something else went live since,
 * the ref is spent and nothing flips ('expired').
 */
export async function undo(control: Sql, tgUserId: number, ref: string): Promise<{ outcome: 'undone' | 'expired' | 'unknown'; text: string | null }> {
  const [r] = await control<{ outcome: string; tenant_id: string | null; action: string | null; payload: { change_request: string; digest: string; previous: string } | null }[]>`
    select * from private.take_owner_ref(${ref}, ${tgUserId})`;
  if (!r || r.outcome === 'unknown' || r.outcome === 'not_yours' || r.action !== 'undo') return { outcome: 'unknown', text: null };
  if (r.outcome !== 'ok') return { outcome: 'expired', text: 'This can no longer be undone.' };
  const p = r.payload!;
  const tenantId = r.tenant_id!;
  const [t] = await inTenant(control, tenantId, (tx) => tx<{ epoch: string; active_digest: string }[]>`select epoch, active_digest from public.tenants where id = ${tenantId}`);
  if (t!.active_digest !== p.digest) return { outcome: 'expired', text: 'Another change went live since, so this one can no longer be undone on its own.' };
  await inTenant(control, tenantId, (tx) => tx`select public.flip_epoch(${tenantId}, ${t!.epoch}, ${p.previous})`);
  // v3 §4.3 then merges a revert PR so Git matches the runtime again; that PR (and change_requests.reverted_by,
  // which names it) comes with the Architect's PR authoring. Until then the pointer is the undo.
  return { outcome: 'undone', text: 'Undone. The previous version is live again.' };
}

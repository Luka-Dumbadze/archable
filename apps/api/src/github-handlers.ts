// apps/api/src/github-handlers.ts: the archable-architect App's events (plan §7.1, §7.3; PROGRESS.md Q9 (3)).
//   pull_request.synchronize    a new head supersedes the change's open cards; DEV-1's editor turns them into
//                               "This change was updated" within the webhook round trip.
//   pull_request_review         an approving review by a developer member is a ledger row for that head; then settle.
import type { CardEditor, SettleDeps } from '@archable/governance';
import { noCards, settle, supersedeCards, textDigest } from '@archable/governance';
import type { App } from 'octokit';
import type postgres from 'postgres';
import { withTenant } from './db';

type Sql = postgres.Sql;

export function registerGithubHandlers(app: App, d: { control: Sql; cards?: CardEditor; kick?(): void; log(event: string, data: Record<string, unknown>): void }) {
  const cards = d.cards ?? noCards;
  const tenantOf = async (installation: number | undefined, repo: string) => {
    if (!installation) return null;
    const [r] = await d.control<{ t: string | null }[]>`select private.tenant_for_repo(${installation}, ${repo}) as t`;
    return r?.t ?? null;
  };
  const changeOf = (tenantId: string, prNumber: number) => withTenant(d.control, tenantId, async (tx) =>
    (await tx<{ id: string; title: string; tier: number; delta_digest: string | null; head_sha: string }[]>`
      select id, title, tier, delta_digest, head_sha from public.change_requests where tenant_id = ${tenantId} and pr_number = ${prNumber}`)[0] ?? null);

  app.webhooks.on('pull_request.synchronize', async ({ id, payload }) => {
    const tenantId = await tenantOf(payload.installation?.id, payload.repository.full_name);
    if (!tenantId) return d.log('github.unknown_repo', { delivery: id, repo: payload.repository.full_name });
    const cr = await changeOf(tenantId, payload.pull_request.number);
    if (!cr) return d.log('github.untracked_pr', { delivery: id, pr: payload.pull_request.number });
    const head = payload.pull_request.head.sha;
    await withTenant(d.control, tenantId, (tx) => tx`update public.change_requests set head_sha = ${head}, state = 'verifying', updated_at = now()
      where tenant_id = ${tenantId} and id = ${cr.id} and state not in ('merging', 'merged', 'closed')`);
    const open = await supersedeCards(d.control, tenantId, cr.id, head);
    await cards.supersede(open, cr.title);                                         // awaited: lands within the round trip
    d.log('github.superseded', { delivery: id, change_request: cr.id, cards: open.length });
    // The new head is verified like the Architect's own (reverify.ts), now rather than at the next tick.
    await d.control`select private.verify_send(${d.control.json({ kind: 'verify', tenant_id: tenantId, change_request_id: cr.id })})`;
    d.kick?.();
  });

  app.webhooks.on('pull_request_review.submitted', async ({ id, payload }) => {
    if (payload.review.state !== 'approved' || !payload.review.user) return;
    const reviewer = payload.review.user.id;
    const tenantId = await tenantOf(payload.installation?.id, payload.repository.full_name);
    if (!tenantId) return d.log('github.unknown_repo', { delivery: id, repo: payload.repository.full_name });
    const cr = await changeOf(tenantId, payload.pull_request.number);
    if (!cr) return;
    const head = payload.review.commit_id;
    const recorded = await withTenant(d.control, tenantId, async (tx) => {
      const [m] = await tx<{ id: string }[]>`select id from public.memberships where tenant_id = ${tenantId} and role = 'developer'
        and github_user_id = ${reviewer} and revoked_at is null`;
      if (!m) return null;                                                          // not a developer of this tenant
      // A review approves the head it was submitted on; the developer saw the diff, so the digest names that head.
      return tx`insert into public.approvals (tenant_id, change_request_id, role, approver, channel, head_sha, delta_digest, summary_digest,
                  tier, status, expires_at, decided_at, evidence)
        values (${tenantId}, ${cr.id}, 'developer', ${m.id}, 'github_review', ${head}, ${cr.delta_digest ?? ''}, ${textDigest(`review of ${head}`)},
                ${cr.tier}, 'approved', now() + interval '7 days', now(), ${tx.json({ review_id: payload.review.id, delivery: id })})
        on conflict do nothing returning id`;
    });
    d.log('github.review', { delivery: id, change_request: cr.id, recorded: !!recorded?.length });
    if (recorded?.length && head === cr.head_sha) {
      const r = await settle({ control: d.control, app, cards, log: d.log } satisfies SettleDeps, cr.id);
      d.log('github.settle', { delivery: id, change_request: cr.id, ...r });
    }
  });
}

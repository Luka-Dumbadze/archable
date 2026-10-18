// packages/governance/src/freeze-rationale.ts: the card for a verified head, frozen into change_requests (plan §7.5).
// Runs once per verified head, in the verify job, on the control plane. Every number comes from desire_impact.
//
// renderOps and labelsFrom are passed in: the plan names them but neither document defines their templates, and the
// spec has no field or enum labels to read yet (PROGRESS.md Q7). Until that is settled the verify job supplies them.
import type postgres from 'postgres';
import type { Bundle } from '@archable/compiler';
import type { ChangeSet } from '@archable/schema';
import type { z } from 'zod';
import { buildChangeRationale, rationaleDigest, type BlastReason, type ChangeRationaleInput, type DesireImpact,
         type Labels, type VerificationResult } from './rationale';

type Tx = postgres.TransactionSql;

export interface ChangeRequest { tenant_id: string; id: string; desire_id: string | null; head_sha: string }

// What the verify job knows about the head: change_requests.blast_radius ({changed, reached, why}) and .verification.
export interface VerifyRun {
  desire: ChangeRationaleInput['desire'];
  ownerRequest?: ChangeRationaleInput['ownerRequest'];
  radius: { changed: string[]; reached: string[]; why: BlastReason[] };   // reached: `${mode}|${node}` state keys
  changeset: z.infer<typeof ChangeSet>;
  verification: VerificationResult;
}

export interface RationaleText {
  renderOps(cs: z.infer<typeof ChangeSet>, bundle: Bundle): string[];   // the approval-summary templates (v3 §4.6)
  labelsFrom(bundle: Bundle, base: Bundle): Labels;
}

// desire_impact's row as postgres.js returns it: bigint as a string, timestamptz as a Date.
interface ImpactRow {
  chapters: number; customers: number; quoted: number; abandoned: number; abandoned_value: string | number;
  ordered: number; first_seen: Date | null; last_seen: Date | null;
}
const toImpact = (r: ImpactRow): DesireImpact => ({
  chapters: r.chapters, customers: r.customers, quoted: r.quoted, abandoned: r.abandoned,
  abandoned_value: Number(r.abandoned_value), ordered: r.ordered,
  first_seen: r.first_seen ? r.first_seen.toISOString() : null, last_seen: r.last_seen ? r.last_seen.toISOString() : null,
});

export async function freezeRationale(tx: Tx, cr: ChangeRequest, run: VerifyRun, bundle: Bundle, base: Bundle, text: RationaleText) {
  const [impact] = await tx<ImpactRow[]>`select * from public.desire_impact(${cr.tenant_id}, ${cr.desire_id}, interval '2 hours')`;
  const changedPolicies = new Set(run.radius.changed.filter((n) => n.startsWith('policy:')).map((n) => n.slice(7)));
  const reachedTools = new Set(run.radius.reached.filter((k) => k.startsWith('run|tool:')).map((k) => k.slice(9)));
  const bounds = bundle.policies.bounds.filter((b) => changedPolicies.has(b.policy) || reachedTools.has(b.action));
  const card = buildChangeRationale({
    changeRequestId: cr.id, headSha: cr.head_sha, desire: run.desire, ...(run.ownerRequest ? { ownerRequest: run.ownerRequest } : {}),
    impact: toImpact(impact!), quietHours: 2, reasons: run.radius.why, bounds, ops: text.renderOps(run.changeset, bundle),
    verification: run.verification, labels: text.labelsFrom(bundle, base), now: new Date().toISOString(),
  });
  await tx`update public.change_requests set rationale = ${tx.json(card as never)}, rationale_digest = ${rationaleDigest(card)}
           where tenant_id = ${cr.tenant_id} and id = ${cr.id}`;
  return card;
}

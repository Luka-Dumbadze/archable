// packages/governance/src/freeze-rationale.ts: the card for a verified head, frozen into change_requests (plan §7.5).
// Runs once per verified head, in the verify job, on the control plane. Every number comes from desire_impact.
// Labels and op sentences come from summary.ts (PROGRESS.md Q7); the risk section shows one witness per rule.
import type postgres from 'postgres';
import type { Bundle } from '@archable/compiler';
import type { ChangeSet } from '@archable/schema';
import type { z } from 'zod';
import { buildChangeRationale, rationaleDigest, type BlastReason, type ChangeRationaleInput, type DesireImpact,
         type VerificationResult } from './rationale';
import { labelsFrom, renderOps, witnesses } from './summary';

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

/** The bounds of policies in Δ or bounding a tool reached in run mode: the card's caps. */
export function boundsFor(bundle: Bundle, radius: Pick<VerifyRun['radius'], 'changed' | 'reached'>) {
  const changedPolicies = new Set(radius.changed.filter((n) => n.startsWith('policy:')).map((n) => n.slice(7)));
  // A tool reached in run mode, or called (`call|`, Q8): its caps bound the change either way.
  const reachedTools = new Set(radius.reached.filter((k) => /^(run|call)\|tool:/.test(k)).map((k) => k.slice(k.indexOf('|tool:') + 6)));
  return bundle.policies.bounds.filter((b) => changedPolicies.has(b.policy) || reachedTools.has(b.action));
}

export async function freezeRationale(tx: Tx, cr: ChangeRequest, run: VerifyRun, bundle: Bundle, base: Bundle, lang = 'en') {
  const [impact] = await tx<ImpactRow[]>`select * from public.desire_impact(${cr.tenant_id}, ${cr.desire_id}, interval '2 hours')`;
  const bounds = boundsFor(bundle, run.radius);
  const card = buildChangeRationale({
    changeRequestId: cr.id, headSha: cr.head_sha, desire: run.desire, ...(run.ownerRequest ? { ownerRequest: run.ownerRequest } : {}),
    impact: toImpact(impact!), quietHours: 2, reasons: witnesses(run.radius), bounds, ops: renderOps(run.changeset.ops, bundle, lang),
    verification: run.verification, labels: labelsFrom(bundle, base, lang), now: new Date().toISOString(),
  });
  await tx`update public.change_requests set rationale = ${tx.json(card as never)}, rationale_digest = ${rationaleDigest(card)}
           where tenant_id = ${cr.tenant_id} and id = ${cr.id}`;
  return card;
}

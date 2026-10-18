// packages/governance/src/approval-check.ts: archable/approval as a pure function of the ledger (§4.2).
import type { Tier } from '@archable/contracts';

export interface LedgerRow {
  role: 'developer' | 'owner';
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'superseded';
  head_sha: string;
  confirm_mode: 'tap' | 'typed' | 'biometric';
  channel: 'telegram_button' | 'telegram_typed' | 'telegram_mini_app' | 'github_review' | 'web';
}

export interface ApprovalInput {
  tier: Tier;
  headSha: string;
  author: 'architect' | 'developer' | 'lovable_studio';
  developerReady: boolean;            // a developer-authored PR marked ready = the author's sign-off
  hasDeveloper: boolean;              // a live developer membership exists
  delegation: { upTo: Tier | null };  // owner → developer delegation; never above T2 (platform rule)
  ledger: LedgerRow[];
}

export type CheckState =
  | { state: 'success'; summary: string }
  | { state: 'in_progress'; summary: string; waitingFor: ('developer' | 'owner')[] }
  | { state: 'failure'; summary: string };

export function evaluateApproval(i: ApprovalInput): CheckState {
  if (i.tier === 0) return { state: 'success', summary: 'T0: the compiled bundle is unchanged.' };
  const rows = i.ledger.filter((r) => r.head_sha === i.headSha);       // approvals of older heads count for nothing
  const rejected = rows.find((r) => r.status === 'rejected');
  if (rejected) return { state: 'failure', summary: `Rejected by the ${rejected.role}.` };

  const stepUp = i.tier >= 3;
  const ok = (role: 'developer' | 'owner') => rows.some((r) => r.role === role && r.status === 'approved' &&
    (!stepUp || role === 'developer' || r.confirm_mode !== 'tap'));
  const developerOk = ok('developer') || (i.author === 'developer' && i.developerReady);
  const delegated = i.delegation.upTo !== null && i.tier <= Math.min(i.delegation.upTo, 2);

  if (stepUp && !i.hasDeveloper) {
    // The two-person rule is what makes the typed confirmation safe; it is never waived.
    return { state: 'in_progress', summary: 'Changes that touch money need a developer. Invite one in Team.', waitingFor: ['developer'] };
  }
  const need: ('developer' | 'owner')[] = [];
  if (i.tier === 1) {
    if (!(ok('owner') || (delegated && developerOk))) need.push('owner');
  } else {
    if (i.hasDeveloper && !developerOk) need.push('developer');
    if (!ok('owner') && !(delegated && developerOk)) need.push('owner');
  }
  return need.length === 0
    ? { state: 'success', summary: `T${i.tier}: approvals complete for ${i.headSha.slice(0, 7)}.` }
    : { state: 'in_progress', summary: `Waiting for ${need.join(' and ')}.`, waitingFor: need };
}

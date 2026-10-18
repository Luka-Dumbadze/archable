import { describe, expect, it } from 'vitest';
import { evaluateApproval, type ApprovalInput, type LedgerRow } from './approval-check';

// The 11 cases of plan §9.3: T0, T3 typed vs tap, stale head, delegation capped at T2, no developer, rejection,
// developer-authored T2, T1.
const HEAD = 'a'.repeat(40), OLD = 'b'.repeat(40);
const row = (role: LedgerRow['role'], over: Partial<LedgerRow> = {}): LedgerRow => ({
  role, status: 'approved', head_sha: HEAD,
  confirm_mode: 'tap', channel: role === 'developer' ? 'github_review' : 'telegram_button', ...over,
});
const input = (over: Partial<ApprovalInput> = {}): ApprovalInput => ({
  tier: 2, headSha: HEAD, author: 'architect', developerReady: false, hasDeveloper: true,
  delegation: { upTo: null }, ledger: [], ...over,
});

describe('evaluateApproval (plan §7.4)', () => {
  it('1. T0 succeeds with no approvals at all', () => {
    expect(evaluateApproval(input({ tier: 0, hasDeveloper: false }))).toEqual({ state: 'success', summary: 'T0: the compiled bundle is unchanged.' });
  });

  it('2. T3 with a developer approval and the owner typed confirmation succeeds', () => {
    const r = evaluateApproval(input({ tier: 3, ledger: [row('developer'), row('owner', { confirm_mode: 'typed', channel: 'telegram_typed' })] }));
    expect(r).toEqual({ state: 'success', summary: `T3: approvals complete for ${HEAD.slice(0, 7)}.` });
  });

  it('3. T3 with only an owner button tap still waits for the owner', () => {
    const r = evaluateApproval(input({ tier: 3, ledger: [row('developer'), row('owner')] }));
    expect(r).toMatchObject({ state: 'in_progress', waitingFor: ['owner'] });
  });

  it('4. approvals of an older head count for nothing', () => {
    const r = evaluateApproval(input({ ledger: [row('developer', { head_sha: OLD }), row('owner', { head_sha: OLD })] }));
    expect(r).toMatchObject({ state: 'in_progress', waitingFor: ['developer', 'owner'] });
  });

  it('5. delegation up to T2 lets the developer approve a T2 alone', () => {
    expect(evaluateApproval(input({ delegation: { upTo: 2 }, ledger: [row('developer')] })).state).toBe('success');
  });

  it('6. delegation is capped at T2: a delegation "up to T4" does not cover a T3', () => {
    const r = evaluateApproval(input({ tier: 3, delegation: { upTo: 4 }, ledger: [row('developer')] }));
    expect(r).toMatchObject({ state: 'in_progress', waitingFor: ['owner'] });
  });

  it('7. T3 without a developer is never waived, even with the owner typed confirmation', () => {
    const r = evaluateApproval(input({ tier: 3, hasDeveloper: false, ledger: [row('owner', { confirm_mode: 'typed', channel: 'telegram_typed' })] }));
    expect(r).toEqual({ state: 'in_progress', summary: 'Changes that touch money need a developer. Invite one in Team.', waitingFor: ['developer'] });
  });

  it('8. a rejection on the current head fails the check, whatever else is approved', () => {
    const r = evaluateApproval(input({ ledger: [row('developer'), row('owner', { status: 'rejected' })] }));
    expect(r).toEqual({ state: 'failure', summary: 'Rejected by the owner.' });
  });

  it('9. a developer-authored T2 marked ready counts as the developer sign-off; the owner is still needed', () => {
    const waiting = evaluateApproval(input({ author: 'developer', developerReady: true }));
    expect(waiting).toMatchObject({ state: 'in_progress', waitingFor: ['owner'] });
    expect(evaluateApproval(input({ author: 'developer', developerReady: true, ledger: [row('owner')] })).state).toBe('success');
  });

  it('10. T1 needs only the owner, a tap is enough', () => {
    expect(evaluateApproval(input({ tier: 1 }))).toMatchObject({ state: 'in_progress', waitingFor: ['owner'] });
    expect(evaluateApproval(input({ tier: 1, ledger: [row('owner')] })).state).toBe('success');
  });

  it('11. T1 under delegation: the developer approval stands in for the owner', () => {
    expect(evaluateApproval(input({ tier: 1, delegation: { upTo: 1 }, ledger: [row('developer')] })).state).toBe('success');
    expect(evaluateApproval(input({ tier: 1, ledger: [row('developer')] }))).toMatchObject({ state: 'in_progress', waitingFor: ['owner'] });
  });
});

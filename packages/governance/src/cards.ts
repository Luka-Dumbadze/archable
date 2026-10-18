// packages/governance/src/cards.ts: approval cards (plan §7.3, v3 §4.6). One approvals row per owner approver per
// head, bound to the head SHA, the delta digest and the digest of the exact text sent; then the card is sent and the
// chat and message it went to are recorded, because consume_telegram_approval only accepts a press on that message.
// The text is rendered from the same templates as the rationale card's "What changes" (summary.ts), so what the owner
// signs and what the card explains can't disagree. Owner-facing text has no Git words (CLAUDE.md §3).
import { createHash, randomBytes } from 'node:crypto';
import type { Bundle } from '@archable/compiler';
import type { Tier } from '@archable/contracts';
import type { ChangeSet } from '@archable/schema';
import type postgres from 'postgres';
import type { z } from 'zod';
import { renderOps } from './summary';

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;
type Ops = z.infer<typeof ChangeSet>['ops'];
const inTenant = <T>(db: Sql, tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  db.begin(async (tx) => { await tx`select set_config('app.tenant_id', ${tenantId}, true)`; return fn(tx); }) as Promise<T>;

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest();
export const textDigest = (text: string) => `sha256:${sha256(Buffer.from(text, 'utf8')).toString('hex')}`;
/** 16 random bytes, base64url: 22 characters, so `a1:<nonce>` fits Telegram's 64-byte callback_data. */
export const newNonce = () => randomBytes(16).toString('base64url');

export interface CardChange {
  tenantId: string; id: string; prNumber: number; headSha: string; deltaDigest: string; tier: Tier; rationaleDigest: string;
  desire: { number: number; statement: string } | null;
}

// What DEV-1's sender gets: the text and the four buttons of changeCardKeyboard (plan §6.3). Approve and Reject carry
// the same nonce; the decision travels in the callback prefix (a1: / r1:), as consume_telegram_approval expects.
export interface CardMessage { chatId: number; text: string; approveNonce: string; rejectNonce: string; rationaleRef: string; previewUrl: string }
export interface Sent { chatId: number; messageId: number; text: string }   // text: as Telegram returned it

export interface CardDeps {
  control: Sql;
  send(card: CardMessage): Promise<Sent>;
  nonce?: () => string;
  now?: () => Date;
}

export type CardOutcome =
  | { outcome: 'sent'; approvalId: string; membershipId: string; chatId: number; messageId: number; summaryDigest: string }
  | { outcome: 'already_sent'; approvalId: string; membershipId: string }
  | { outcome: 'not_needed'; reason: string }
  | { outcome: 'send_failed' | 'text_changed'; membershipId: string; error: string };

const TIER_LINE: Record<number, string> = {
  1: 'Tap Approve to put it live.',
  2: 'Tap Approve to put it live.',
  3: 'It touches money or an outside company, so approving asks you to type a short code.',
  4: 'It changes how changes are approved, so approving asks you to type a short code.',
};

/** The exact text of the card: what the approval's summary_digest binds (v3 §4.6 step 1, the deterministic template). */
export function cardText(c: { osName: string; desire: CardChange['desire']; tier: Tier; ttlHours: number; sentences: string[] }): string {
  return [
    `${c.osName}: a change is ready${c.desire ? ` (D-${c.desire.number})` : ''}.`,
    ...(c.desire ? [c.desire.statement] : []),
    '',
    'What changes:',
    ...c.sentences.map((s) => `· ${s}`),
    '',
    TIER_LINE[c.tier] ?? TIER_LINE[2]!,
    `This request is valid for ${c.ttlHours} hours.`,
  ].join('\n');
}

/** Owners approve when the tier's approver list names them ('owner' or 'owner+step_up'). */
const ownerApproves = (bundle: Bundle, tier: Tier) => (bundle.governance.approvals[`T${tier}`] ?? []).some((r) => r.split('+')[0] === 'owner');

export async function issueCards(d: CardDeps, cr: CardChange, head: Bundle, ops: Ops, o: { slug: string; lang?: string }): Promise<CardOutcome[]> {
  if (!ownerApproves(head, cr.tier)) return [{ outcome: 'not_needed', reason: `T${cr.tier} needs no owner approval` }];
  const ttlHours = head.governance.cardTtlHours[cr.tier] ?? 24;
  const text = cardText({ osName: head.metadata.os_name, desire: cr.desire, tier: cr.tier, ttlHours, sentences: renderOps(ops, head, o.lang ?? 'en') });
  const summaryDigest = textDigest(text);
  const stepUp = cr.tier >= 3;
  const now = d.now?.() ?? new Date();
  const expiresAt = new Date(now.getTime() + ttlHours * 3_600_000);

  const owners = await inTenant(d.control, cr.tenantId, (tx) => tx<{ id: string; tg_user_id: string | null }[]>`
    select id, tg_user_id from public.memberships
     where tenant_id = ${cr.tenantId} and role = 'owner' and revoked_at is null order by created_at`);
  if (!owners.length) return [{ outcome: 'not_needed', reason: 'the tenant has no owner' }];

  const out: CardOutcome[] = [];
  for (const m of owners) {
    if (!m.tg_user_id) { out.push({ outcome: 'not_needed', reason: `owner ${m.id} has no Telegram account` }); continue; }
    const nonce = (d.nonce ?? newNonce)();
    // One pending card per approver: a card for this head already out is not sent again (a retried verify job).
    const created = await inTenant(d.control, cr.tenantId, async (tx) => {
      const [open] = await tx<{ id: string; head_sha: string }[]>`select id, head_sha from public.approvals
        where tenant_id = ${cr.tenantId} and change_request_id = ${cr.id} and role = 'owner' and approver = ${m.id} and status = 'pending'`;
      if (open && open.head_sha === cr.headSha) return { existing: open.id };
      if (open) await tx`update public.approvals set status = 'superseded' where id = ${open.id}`;   // an older head
      const [a] = await tx<{ id: string }[]>`insert into public.approvals
          (tenant_id, change_request_id, role, approver, channel, nonce_hash, head_sha, delta_digest, summary_digest, tier,
           step_up, confirm_mode, expires_at, evidence)
        values (${cr.tenantId}, ${cr.id}, 'owner', ${m.id}, 'telegram_button', ${sha256(nonce)}, ${cr.headSha}, ${cr.deltaDigest},
                ${summaryDigest}, ${cr.tier}, ${stepUp}, ${stepUp ? 'typed' : 'tap'}, ${expiresAt},
                ${tx.json({ rationale_digest: cr.rationaleDigest, summary: text })})
        returning id`;
      return { id: a!.id };
    });
    if ('existing' in created) { out.push({ outcome: 'already_sent', approvalId: created.existing!, membershipId: m.id }); continue; }

    let sent: Sent;
    try {
      sent = await d.send({ chatId: Number(m.tg_user_id), text, approveNonce: nonce, rejectNonce: nonce, rationaleRef: cr.id,
                            previewUrl: `https://pr-${cr.prNumber}--${o.slug}.archable.run` });
    } catch (e) {
      // Never shown, so it must not be approvable: the nonce dies with the row.
      await inTenant(d.control, cr.tenantId, (tx) => tx`delete from public.approvals where id = ${created.id}`);
      out.push({ outcome: 'send_failed', membershipId: m.id, error: String(e) });
      continue;
    }
    // The approval binds the exact text the owner saw (I4). If Telegram changed it, the row can't stand.
    if (textDigest(sent.text) !== summaryDigest) {
      await inTenant(d.control, cr.tenantId, (tx) => tx`update public.approvals set status = 'superseded',
        tg_chat_id = ${sent.chatId}, tg_message_id = ${sent.messageId} where id = ${created.id}`);
      out.push({ outcome: 'text_changed', membershipId: m.id, error: `sent ${summaryDigest}, Telegram has ${textDigest(sent.text)}` });
      continue;
    }
    await inTenant(d.control, cr.tenantId, (tx) => tx`update public.approvals
      set tg_chat_id = ${sent.chatId}, tg_message_id = ${sent.messageId} where id = ${created.id}`);
    out.push({ outcome: 'sent', approvalId: created.id, membershipId: m.id, chatId: sent.chatId, messageId: sent.messageId, summaryDigest });
  }
  return out;
}

export interface OpenCard { approvalId: string; chatId: number; messageId: number }

/**
 * A new head supersedes every open card of the change (v3 §4.2). Returns the cards to edit to "This change was updated"
 * with their buttons removed; the caller (the pull_request.synchronize handler) awaits DEV-1's cardEditor.supersede.
 */
export async function supersedeCards(control: Sql, tenantId: string, changeRequestId: string, headSha: string): Promise<OpenCard[]> {
  const rows = await inTenant(control, tenantId, (tx) => tx<{ id: string; tg_chat_id: string | null; tg_message_id: number | null }[]>`
    update public.approvals set status = 'superseded'
     where tenant_id = ${tenantId} and change_request_id = ${changeRequestId} and status = 'pending' and head_sha <> ${headSha}
     returning id, tg_chat_id, tg_message_id`);
  return rows.filter((r) => r.tg_chat_id && r.tg_message_id).map((r) => ({ approvalId: r.id, chatId: Number(r.tg_chat_id), messageId: r.tg_message_id! }));
}

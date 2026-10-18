// issueCards and supersedeCards against the real database (P4.D2.6), on a throwaway tenant deleted at the end.
// The sender is a stand-in that returns the text the way Telegram's sendMessage does; the live Telegram run is
// scripts/send-card.ts. Skipped without DATABASE_URL_CONTROL.
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '@archable/compiler';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { issueCards, sha256, supersedeCards, textDigest, type CardChange, type CardMessage } from './cards';

const live = Boolean(process.env.DATABASE_URL_CONTROL);
const ROOT = fileURLToPath(new URL('../../../fixtures/marani', import.meta.url));
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const files = Object.fromEntries(walk(ROOT).map((p) => [relative(ROOT, p).replace(/\\/g, '/'), readFileSync(p, 'utf8')]));
const bundle = compile({ files }, YAML.parse(files['archable.lock']!)).bundle;
const OPS = [
  { op: 'add_enum', path: 'objects.order.fields.payment', value: 'cod', label: 'cash on delivery' },
  { op: 'add_policy', file: 'payment.cedar', id: 'payment.cod_limit', cedar: '…', summary: 'Cash on delivery is refused above 300 GEL.' },
] as never;

describe.skipIf(!live)('approval cards against archable', { timeout: 30_000 }, () => {
  const control = postgres(process.env.DATABASE_URL_CONTROL!, { prepare: false, max: 2 });
  const tenant = randomUUID();
  const slug = `zz-p4-${randomBytes(3).toString('hex')}`;
  const owner = { id: randomUUID(), tg: 7_100_000_000 + Math.floor(Math.random() * 1e8) };
  const crId = randomUUID();
  const inT = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) =>
    control.begin(async (tx) => { await tx`select set_config('app.tenant_id', ${tenant}, true)`; return fn(tx); }) as Promise<T>;
  const sent: CardMessage[] = [];
  let messageId = 500;
  const telegram = { send: async (c: CardMessage) => { sent.push(c); return { chatId: c.chatId, messageId: ++messageId, text: c.text }; } };
  const cr = (over: Partial<CardChange> = {}): CardChange => ({ tenantId: tenant, id: crId, prNumber: 58, headSha: 'a'.repeat(40),
    deltaDigest: 'sha256:' + '1'.repeat(64), tier: 3, rationaleDigest: 'sha256:' + '2'.repeat(64),
    desire: { number: 14, statement: 'Customers can pay cash on delivery up to 300 GEL.' }, ...over });

  beforeAll(async () => {
    await inT(async (tx) => {
      await tx`insert into public.tenants (id, slug, name, os_name, status) values (${tenant}, ${slug}, 'P4 test', 'P4 OS', 'live')`;
      await tx`insert into public.memberships (id, tenant_id, role, display_name, tg_user_id) values (${owner.id}, ${tenant}, 'owner', 'Owner', ${owner.tg})`;
      await tx`insert into public.change_requests (tenant_id, id, pr_number, title, author_kind, base_sha, head_sha, tier)
               values (${tenant}, ${crId}, 58, 'D-14', 'architect', ${'b'.repeat(40)}, ${'a'.repeat(40)}, 3)`;
    });
  });
  afterAll(async () => {
    await control.end();
  });

  let nonce = '';
  it('a T3 card: one row bound to the head, the delta and the exact text sent; typed confirmation; chat and message recorded', async () => {
    const [r] = await issueCards({ control, ...telegram }, cr(), bundle, OPS, { slug });
    expect(r).toMatchObject({ outcome: 'sent', membershipId: owner.id, chatId: owner.tg });
    const card = sent[0]!;
    nonce = card.approveNonce;
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(card.rejectNonce).toBe(nonce);
    expect(card.previewUrl).toBe(`https://pr-58--${slug}.archable.run`);
    expect(card.text).toContain('Payment method can now be cash on delivery.');
    expect(card.text).not.toMatch(/\b(branch|merge|PR|diff|commit)\b/i);                // CLAUDE.md §3
    const [a] = await inT((tx) => tx`select * from public.approvals where change_request_id = ${crId}`);
    expect(a).toMatchObject({ role: 'owner', approver: owner.id, channel: 'telegram_button', head_sha: 'a'.repeat(40), tier: 3,
      step_up: true, confirm_mode: 'typed', status: 'pending', summary_digest: textDigest(card.text), tg_message_id: messageId });
    expect(Number(a!.tg_chat_id)).toBe(owner.tg);
    expect(Buffer.compare(a!.nonce_hash, sha256(nonce))).toBe(0);
    expect(a!.evidence).toMatchObject({ rationale_digest: 'sha256:' + '2'.repeat(64), summary: card.text });
    expect(Math.round((a!.expires_at.getTime() - Date.now()) / 3_600_000)).toBe(24);   // governance.card_ttl.T3
  });

  it('the press is bound to that message: wrong message refused; T3 approve needs the typed step', async () => {
    const consume = (msg: number, decision: string) => inT((tx) => tx<{ outcome: string }[]>`
      select outcome from public.consume_telegram_approval(${sha256(nonce)}, ${owner.tg}, ${owner.tg}, ${msg}, ${decision}, '{}'::jsonb)`);
    expect((await consume(messageId + 1, 'approve'))[0]!.outcome).toBe('wrong_message');
    expect((await consume(messageId, 'approve'))[0]!.outcome).toBe('step_up_required');
  });

  it('a retried issue for the same head sends nothing', async () => {
    const [r] = await issueCards({ control, ...telegram }, cr(), bundle, OPS, { slug });
    expect(r).toMatchObject({ outcome: 'already_sent' });
    expect(sent).toHaveLength(1);
  });

  it('a new head supersedes the open card and returns it for editing; the next card is a new row', async () => {
    const open = await supersedeCards(control, tenant, crId, 'c'.repeat(40));
    expect(open).toEqual([{ approvalId: expect.any(String), chatId: owner.tg, messageId }]);
    expect(await supersedeCards(control, tenant, crId, 'c'.repeat(40))).toEqual([]);   // idempotent
    const [r] = await issueCards({ control, ...telegram }, cr({ headSha: 'c'.repeat(40) }), bundle, OPS, { slug });
    expect(r).toMatchObject({ outcome: 'sent' });
    const rows = await inT((tx) => tx<{ status: string; head_sha: string }[]>`select status, head_sha from public.approvals
      where change_request_id = ${crId} order by created_at`);
    expect(rows.map((x) => [x.status, x.head_sha[0]])).toEqual([['superseded', 'a'], ['pending', 'c']]);
  });

  it('a card Telegram altered is not approvable; a card that failed to send leaves no row', async () => {
    await supersedeCards(control, tenant, crId, 'd'.repeat(40));
    const altered = await issueCards({ control, send: async (c) => ({ chatId: c.chatId, messageId: 900, text: c.text.trim() + ' ' }) },
      cr({ headSha: 'd'.repeat(40) }), bundle, OPS, { slug });
    expect(altered[0]).toMatchObject({ outcome: 'text_changed' });
    const failed = await issueCards({ control, send: async () => { throw new Error('403 Forbidden: bot was blocked by the user'); } },
      cr({ headSha: 'e'.repeat(40) }), bundle, OPS, { slug });
    expect(failed[0]).toMatchObject({ outcome: 'send_failed' });
    const byHead = await inT((tx) => tx<{ status: string; h: string }[]>`select status, left(head_sha, 1) as h from public.approvals
      where change_request_id = ${crId} and left(head_sha, 1) in ('d', 'e')`);
    expect(byHead).toEqual([{ status: 'superseded', h: 'd' }]);                    // altered: kept, not pending; failed: gone
  });

  it('a tenant with approvals can be deleted: they go with its memberships (Q6)', async () => {
    const before = await inT((tx) => tx<{ n: number }[]>`select count(*)::int as n from public.approvals where tenant_id = ${tenant}`);
    expect(before[0]!.n).toBeGreaterThan(0);
    await inT((tx) => tx`delete from public.tenants where id = ${tenant}`);
    const after = await inT((tx) => tx<{ n: number }[]>`select count(*)::int as n from public.approvals where tenant_id = ${tenant}`);
    expect(after[0]!.n).toBe(0);
  });

  it('T0 needs no card', async () => {
    expect(await issueCards({ control, ...telegram }, cr({ tier: 0 }), bundle, OPS, { slug })).toEqual([{ outcome: 'not_needed', reason: 'T0 needs no owner approval' }]);
  });
});

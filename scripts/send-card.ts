// scripts/send-card.ts: P4.D2.6's live check. Issues a real approval card for a scratch T3 change on Marani to the
// owner's Telegram chat, then compares the approval's summary_digest with sha256 of the text Telegram returned.
// Afterwards the card's buttons are removed and the scratch rows deleted.
//   ARCHABLE_BOT_TOKEN=… pnpm tsx scripts/send-card.ts [--tenant marani]
// The owner must have pressed Start in a private chat with that bot. The keyboard is laid out as DEV-1's
// changeCardKeyboard (plan §6.3); the API wires DEV-1's sender itself once feat/frontend-ui is merged.
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';
import YAML from 'yaml';
import { compile } from '@archable/compiler';
import { controlDb, withTenant } from '../apps/api/src/db';
import { issueCards, textDigest, type CardMessage, type Sent } from '../packages/governance/src/index';

const { values } = parseArgs({ options: { tenant: { type: 'string', default: 'marani' } } });
const slug = values.tenant!;
const token = process.env.ARCHABLE_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('set ARCHABLE_BOT_TOKEN (the bot that sends owner cards)');

const api = async <T>(method: string, body: unknown): Promise<T> => {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json()) as { ok: boolean; result: T; description?: string; error_code?: number };
  if (!j.ok) throw new Error(`${method}: ${j.error_code} ${j.description}`);
  return j.result;
};
const keyboard = (c: CardMessage) => ({ inline_keyboard: [
  [{ text: 'Preview', url: c.previewUrl }, { text: 'ℹ️ View rationale', callback_data: `rv:c:${c.rationaleRef}` }],
  [{ text: 'Approve…', callback_data: `a1:${c.approveNonce}` }, { text: 'Reject', callback_data: `r1:${c.rejectNonce}` }],
] });
const received = new Map<number, string>();                     // message id → the text in Telegram's own answer
const send = async (c: CardMessage): Promise<Sent> => {
  const m = await api<{ message_id: number; chat: { id: number }; text: string }>('sendMessage', { chat_id: c.chatId, text: c.text, reply_markup: keyboard(c) });
  received.set(m.message_id, m.text);
  return { chatId: m.chat.id, messageId: m.message_id, text: m.text };
};

const ROOT = `fixtures/${slug}`;
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const files = Object.fromEntries(walk(ROOT).map((p) => [relative(ROOT, p).split(sep).join('/'), readFileSync(p, 'utf8').replace(/\r\n/g, '\n')]));
const { bundle } = compile({ files }, YAML.parse(files['archable.lock']!));
const h = createHash('sha256').update(`archable:tenant:${slug}`).digest('hex');
const tenantId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;

const crId = randomUUID();
const pr = 900_000 + randomInt(99_999);
await withTenant(controlDb, tenantId, (tx) => tx`insert into public.change_requests (tenant_id, id, pr_number, title, author_kind, base_sha, head_sha, tier)
  values (${tenantId}, ${crId}, ${pr}, 'P4.D2.6 scratch card', 'architect', ${'b'.repeat(40)}, ${'a'.repeat(40)}, 3)`);
try {
  const ops = [
    { op: 'add_enum', path: 'objects.order.fields.payment', value: 'cod', label: 'cash on delivery' },
    { op: 'add_policy', file: 'payment.cedar', id: 'payment.cod_limit', cedar: '…', summary: 'Cash on delivery is refused above 300 GEL.' },
    { op: 'edit_persona', agent: 'cellar_master', find: '…', replace: '…', summary: 'Cellar Master mentions it when asked how to pay.' },
  ] as never;
  const outcomes = await issueCards({ control: controlDb, send }, { tenantId, id: crId, prNumber: pr, headSha: 'a'.repeat(40),
    deltaDigest: 'sha256:' + '0'.repeat(64), tier: 3, rationaleDigest: 'sha256:' + '0'.repeat(64),
    desire: { number: 0, statement: 'Test card from P4.D2.6: no action needed.' } }, bundle, ops, { slug });
  for (const o of outcomes) {
    console.log(JSON.stringify(o));
    if (o.outcome !== 'sent') continue;
    const [a] = await withTenant(controlDb, tenantId, (tx) => tx<{ summary_digest: string; tg_message_id: number }[]>`
      select summary_digest, tg_message_id from public.approvals where id = ${o.approvalId}`);
    const got = textDigest(received.get(o.messageId) ?? '');     // sendMessage's result: the text Telegram stored
    console.log(`approval summary_digest          ${a!.summary_digest}`);
    console.log(`sha256(text Telegram received)   ${got}  ${a!.summary_digest === got ? 'equal ✓' : 'DIFFERENT ✗'}`);
    console.log(`card message ${a!.tg_message_id} in the owner's chat`);
    await api('editMessageReplyMarkup', { chat_id: o.chatId, message_id: o.messageId, reply_markup: { inline_keyboard: [] } });
    console.log('buttons removed from the test card');
  }
} finally {
  await withTenant(controlDb, tenantId, async (tx) => {
    await tx`delete from public.approvals where tenant_id = ${tenantId} and change_request_id = ${crId}`;
    await tx`delete from public.change_requests where tenant_id = ${tenantId} and id = ${crId}`;
  });
  await controlDb.end();
}

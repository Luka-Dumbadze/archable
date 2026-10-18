// apps/api/src/architect-wiring.ts: the Architect's jobs with their real dependencies (P4.D2.8): the models and Jev
// as the turn engine has them (Q5), a turn engine pinned per eval env, the GitHub App, and the queue drain with its
// kick. The kick runs a drain inside waitUntil, so an enqueuer's response doesn't wait for it (v3 §8).
import type { AuthorDeps } from '@archable/architect';
import type { CardDeps } from '@archable/governance';
import { typesafeDecisionModel } from '@archable/runtime';
import { waitUntil } from '@vercel/functions';
import type { App } from 'octokit';
import { controlDb, withTenant } from './db';
import { createQueueDrainer } from './queue-drain';
import { createLanguageModels, createTriggerDrainer, createTurnEngine } from './turn-wiring';

// One Architect per process: app.ts (cron, GitHub) and channels/live.ts (@ArchableBot's Draft it) share its drain.
let shared: ReturnType<typeof createArchitect> | null = null;

/**
 * A draft job, step by step, in the owner's chat: one @ArchableBot message, edited as the Architect works, so the owner
 * sees the test it wrote, each attempt and each check. Owner copy: no Git words (CLAUDE.md §3). Best effort: a failed
 * send or edit never touches the job.
 */
export function telegramDraftProgress(botToken: string): NonNullable<AuthorDeps['progress']> {
  const call = async (method: string, body: object) => {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.json() as Promise<{ ok: boolean; result?: { message_id: number } }>;
  };
  const jobs = new Map<string, { chatId: number | null; messageId: number | null; lines: string[]; chain: Promise<void> }>();
  const line = (event: string, data: Record<string, unknown>): string | null => {
    switch (event) {
      case 'architect.started': return '⏳ Reading your request';
      case 'architect.reproduced': return data.fails_on_base ? '✓ Wrote a test for it: today’s assistant fails it' : '✓ Wrote a test for it: today’s assistant already passes it';
      case 'architect.patch': return `⏳ Changing the assistant (attempt ${data.attempt})`;
      case 'architect.compiled': return `✓ Built the new version (attempt ${data.attempt}) · now running every check`;
      case 'architect.verify_failed': return `✗ A check failed on attempt ${data.attempt}: trying again`;
      case 'architect.opened': return '✓ Every check passed. The change is ready for you:';
      case 'architect.to_developer': return '✗ I couldn’t make every check pass. I sent it to your developer.';
      default: return null;
    }
  };
  return (tenantId, desire, event, data) => {
    const text = line(event, data);
    if (!text) return;
    const key = `${tenantId}:${desire}`;
    const job = jobs.get(key) ?? { chatId: null, messageId: null, lines: [], chain: Promise.resolve() };
    jobs.set(key, job);
    if (job.lines.at(-1)?.startsWith('⏳')) job.lines[job.lines.length - 1] = job.lines.at(-1)!.replace('⏳', '✓');
    job.lines.push(text);
    job.chain = job.chain.then(async () => {
      if (job.chatId === null) {
        const [o] = await withTenant(controlDb, tenantId, (tx) => tx<{ tg_user_id: string | null }[]>`
          select tg_user_id from public.memberships where tenant_id = ${tenantId} and role = 'owner' and revoked_at is null limit 1`);
        if (!o?.tg_user_id) return;
        job.chatId = Number(o.tg_user_id);
      }
      const body = `Working on your request (D-${desire})\n\n${job.lines.join('\n')}`;
      if (job.messageId === null) job.messageId = (await call('sendMessage', { chat_id: job.chatId, text: body })).result?.message_id ?? null;
      else await call('editMessageText', { chat_id: job.chatId, message_id: job.messageId, text: body });
      if (event === 'architect.opened' || event === 'architect.to_developer') jobs.delete(key);
    }).catch(() => {});
  };
}

/** The owner's change card through @ArchableBot, laid out as DEV-1's changeCardKeyboard (plan §6.3). */
export function telegramCardSender(botToken: string): CardDeps['send'] {
  return async (c) => {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: c.chatId, text: c.text, reply_markup: { inline_keyboard: [
        [{ text: 'Preview', url: c.previewUrl }, { text: 'ℹ️ View rationale', callback_data: `rv:c:${c.rationaleRef}` }],
        [{ text: 'Approve…', callback_data: `a1:${c.approveNonce}` }, { text: 'Reject', callback_data: `r1:${c.rejectNonce}` }]] } }) });
    const j = await r.json() as { ok: boolean; description?: string; result: { message_id: number; chat: { id: number }; text: string } };
    if (!j.ok) throw new Error(`sendMessage: ${j.description}`);
    return { chatId: j.result.chat.id, messageId: j.result.message_id, text: j.result.text };
  };
}
export function sharedArchitect(o: Parameters<typeof createArchitect>[0]) {
  shared ??= createArchitect(o);
  return shared;
}

/** @ArchableBot's side of the Architect: the owner's card and the draft's live progress message. */
export const telegramOwnerDeps = (botToken: string) => ({ send: telegramCardSender(botToken), progress: telegramDraftProgress(botToken) });

export function createArchitect(o: { app: App; send?: CardDeps['send']; progress?: AuthorDeps['progress']; log(event: string, data: Record<string, unknown>): void }) {
  if (!process.env.TYPESAFE_API_KEY) throw new Error('the Architect needs TYPESAFE_API_KEY (Jev decides and judges)');
  const author: AuthorDeps = {
    control: controlDb, app: o.app, models: createLanguageModels(), jev: typesafeDecisionModel({ apiKey: process.env.TYPESAFE_API_KEY }),
    engine: (pinned, observe) => createTurnEngine({ pinned, observe }), log: o.log, ...(o.send ? { send: o.send } : {}), ...(o.progress ? { progress: o.progress } : {}),
  };
  const triggers = createTriggerDrainer();
  const drain = createQueueDrainer({ control: controlDb, author, triggers: (qty) => triggers(qty), log: o.log });
  // Returns the drain too, for a caller that outlives no request (a script) and wants to await it.
  const kick = (): Promise<void> => {
    const p = drain().then((r) => o.log('queue.kick', { ...r }), (e: unknown) => o.log('queue.kick_failed', { error: String(e) }));
    waitUntil(p);
    return p;
  };
  return { author, drain, kick };
}

// apps/api/src/architect-wiring.ts: the Architect's jobs with their real dependencies (P4.D2.8): the models and Jev
// as the turn engine has them (Q5), a turn engine pinned per eval env, the GitHub App, and the queue drain with its
// kick. The kick runs a drain inside waitUntil, so an enqueuer's response doesn't wait for it (v3 §8).
import type { AuthorDeps } from '@archable/architect';
import type { CardDeps } from '@archable/governance';
import { typesafeDecisionModel } from '@archable/runtime';
import { waitUntil } from '@vercel/functions';
import type { App } from 'octokit';
import { controlDb } from './db';
import { createQueueDrainer } from './queue-drain';
import { createLanguageModels, createTriggerDrainer, createTurnEngine } from './turn-wiring';

// One Architect per process: app.ts (cron, GitHub) and channels/live.ts (@ArchableBot's Draft it) share its drain.
let shared: ReturnType<typeof createArchitect> | null = null;

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

export function createArchitect(o: { app: App; send?: CardDeps['send']; log(event: string, data: Record<string, unknown>): void }) {
  if (!process.env.TYPESAFE_API_KEY) throw new Error('the Architect needs TYPESAFE_API_KEY (Jev decides and judges)');
  const author: AuthorDeps = {
    control: controlDb, app: o.app, models: createLanguageModels(), jev: typesafeDecisionModel({ apiKey: process.env.TYPESAFE_API_KEY }),
    engine: (pinned, observe) => createTurnEngine({ pinned, observe }), log: o.log, ...(o.send ? { send: o.send } : {}),
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

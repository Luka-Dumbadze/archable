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

// packages/architect/src/intake.ts: owner text → desire (plan §7.7). One Jev request answers both questions: what
// the owner wants (intent), and whether an open desire already says it (same_as). Jev decides; a language model
// only rewrites the request as one normalized statement, which the owner confirms with Draft it / Not this.
import type { Experimental_DecisionModelV4 } from '@ai-sdk/provider';
import { experimental_decide, generateText, Output } from 'ai';
import { z } from 'zod';
import type { Lane } from './patch';
import type { DesireStore, OpenDesire } from './store';

type Reasoning = NonNullable<Parameters<typeof generateText>[0]['reasoning']>;

export const INTENTS = {
  change: 'asks to change how the business works',
  question: 'asks about the business or its numbers',
  status: 'asks about a pending change',
  other: 'anything else',
} as const;

export interface IntakeDeps { jev: Experimental_DecisionModelV4; lane: Lane; store: DesireStore; decide?: typeof experimental_decide }
export type IntakeResult =
  | { outcome: 'opened' | 'attached'; desire: OpenDesire; intent: 'change'; p: number }
  | { outcome: 'not_a_change'; intent: Exclude<keyof typeof INTENTS, 'change'>; p: number };

const Statement = z.object({ statement: z.string().min(8).max(200) });

export async function normalize(lane: Lane, text: string): Promise<string> {
  const { output } = await generateText({
    model: lane.model, ...(lane.reasoning ? { reasoning: lane.reasoning as Reasoning } : {}), maxRetries: 1,
    output: Output.object({ schema: Statement }),
    system: 'Rewrite a business owner\'s request as one plain English sentence stating the change they want, '
      + 'as a rule of the business (e.g. "Customers can pay cash on delivery for orders up to 300 GEL."). '
      + 'Keep every number and limit; write amounts in GEL. Add nothing the owner did not say.',
    prompt: text,
  });
  return Statement.parse(output).statement;
}

export async function intake(d: IntakeDeps, i: { tenantId: string; membershipId?: string; text: string; at: string }): Promise<IntakeResult> {
  const decide = d.decide ?? experimental_decide;
  const open = await d.store.open(i.tenantId);
  const sameAs = Object.fromEntries([...open.map((x) => [`D-${x.number}`, x.statement]), ['new', 'none of these']]);
  const r = await decide({
    model: d.jev, maxRetries: 1,
    state: { message: i.text, open_desires: open.map((x) => `D-${x.number}: ${x.statement}`).join('\n') || '(none)' },
    questions: {
      intent: { type: 'choice', instructions: 'What does the owner want with this message?', criteria: INTENTS },
      ...(open.length ? { same_as: { type: 'choice' as const, instructions: 'Which open request says the same thing as this message?', criteria: sameAs } } : {}),
    },
  });
  const answers = r.answers as Record<string, { choice: string; probabilities?: Record<string, number> }>;
  const intent = answers.intent!.choice as keyof typeof INTENTS;
  const p = answers.intent!.probabilities?.[intent] ?? 1;
  if (intent !== 'change') return { outcome: 'not_a_change', intent, p };

  const evidence = { kind: 'owner_message' as const, at: i.at, text: i.text, ...(i.membershipId ? { membership_id: i.membershipId } : {}) };
  const same = answers.same_as?.choice;
  const existing = same && same !== 'new' ? open.find((x) => `D-${x.number}` === same) : undefined;
  if (existing) return { outcome: 'attached', desire: await d.store.addEvidence(i.tenantId, existing.id, evidence), intent, p };
  const statement = await normalize(d.lane, i.text);
  return { outcome: 'opened', desire: await d.store.create(i.tenantId, { source: 'owner_request', statement, evidence }), intent, p };
}

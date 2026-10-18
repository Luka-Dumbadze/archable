// packages/architect/src/cluster.ts: failures → desires (v3 §7.2, Cluster and Trigger). A Jev Choice over the open
// desires, plus "new": attach the failure (and its chapter) to a desire, or open one. Drafting starts when a desire
// has ≥ 3 occurrences or the failure has severity ≥ 4 (the caller also checks open PRs and max_open_prs).
import type { Experimental_DecisionModelV4 } from '@ai-sdk/provider';
import { experimental_decide } from 'ai';
import { normalize } from './intake';
import type { Lane } from './patch';
import type { DesireStore, OpenDesire } from './store';

export interface Failure { tenantId: string; id: number; turnId: string | null; kind: string; severity: number; summary: string; chapterId: string | null; at: string }
export interface ClusterDeps { jev: Experimental_DecisionModelV4; lane: Lane; store: DesireStore; decide?: typeof experimental_decide }
export interface ClusterResult { outcome: 'opened' | 'attached'; desire: OpenDesire; p: number; draft: boolean }

export const TRIGGER = { occurrences: 3, severity: 4 } as const;

export async function clusterFailure(d: ClusterDeps, f: Failure): Promise<ClusterResult> {
  const decide = d.decide ?? experimental_decide;
  const open = await d.store.open(f.tenantId);
  const evidence = { kind: 'failure' as const, at: f.at, failure_id: f.id, ...(f.turnId ? { turn_id: f.turnId } : {}), text: f.summary };
  let desire: OpenDesire | undefined;
  let p = 1;
  if (open.length) {
    const r = await decide({
      model: d.jev, maxRetries: 1,
      state: { failure: `${f.kind}: ${f.summary}`, open_desires: open.map((x) => `D-${x.number}: ${x.statement}`).join('\n') },
      questions: { same_as: { type: 'choice', instructions: 'Which open request would fix this failure?',
        criteria: Object.fromEntries([...open.map((x) => [`D-${x.number}`, x.statement]), ['new', 'none of these']]) } },
    });
    const a = (r.answers as Record<string, { choice: string; probabilities?: Record<string, number> }>).same_as!;
    p = a.probabilities?.[a.choice] ?? 1;
    const hit = open.find((x) => `D-${x.number}` === a.choice);
    if (hit) desire = await d.store.addEvidence(f.tenantId, hit.id, evidence);
  }
  const outcome = desire ? 'attached' : 'opened';
  desire ??= await d.store.create(f.tenantId, { source: 'failure_cluster', statement: await normalize(d.lane, f.summary), evidence });
  if (f.chapterId) await d.store.linkChapter(f.tenantId, desire.id, f.chapterId, p);
  await d.store.assignFailure(f.tenantId, f.id, desire.id);
  return { outcome, desire, p, draft: desire.occurrences >= TRIGGER.occurrences || f.severity >= TRIGGER.severity };
}

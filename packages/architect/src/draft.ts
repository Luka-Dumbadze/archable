// packages/architect/src/draft.ts: one desire through the loop of v3 §7.2, without side effects outside the eval env:
// reproduce (the case must fail on the base) → patch → compile → blast radius → verify, up to max_patch_attempts.
// The dry run (scripts/architect-dry.ts) prints the result; the cron's draft job (author.ts) opens the PR from it.
import type { BlastRadius, Bundle, CompileResult, Lock } from '@archable/compiler';
import type { Env } from '@archable/contracts';
import type { HandleTurn } from '@archable/runtime';
import type { ChangeSet } from '@archable/schema';
import type { LanguageModel } from 'ai';
import type postgres from 'postgres';
import type { z } from 'zod';
import { closeEvalEnv, evalHost, openEvalEnv, type HostDeps } from './eval-host';
import { runOnce, type EvalCase } from './evals';
import { heal, type Head } from './heal';
import { draftPatch, reproduce, type DesireBrief, type Lane } from './patch';
import { selectTests, verify, type Verification } from './verify';

type Observe = (turnId: string | null, tool: string, output: Record<string, unknown>) => void;

export interface DraftDeps {
  control: postgres.Sql;
  models(slug: string): LanguageModel;
  jev: HostDeps['judgeModel'];
  engine(pinned: { env: Env; digest: string; bundle: Bundle }, observe: Observe): HandleTurn;   // a pinned turn engine
  log?(event: string, data: Record<string, unknown>): void;
}

export interface DraftInput {
  tenantId: string;
  desire: DesireBrief;
  base: { files: Record<string, string>; lock: Lock; compiled: CompileResult; gitSha: string };
  env: Env;                                           // the eval env: pr-<n> rows, cleaned afterwards
}

export interface Failing { suite: string; id: string; yaml: string; case: EvalCase }
export type DraftResult =
  | { outcome: 'no_gap'; failing: Failing }
  | { outcome: 'to_developer'; failing: Failing; attempts: number; feedback: string[] }
  | { outcome: 'ready'; failing: Failing; baseFailures: string[]; attempts: number; changeset: z.infer<typeof ChangeSet>; head: Head;
      radius: BlastRadius; verification: Verification };

/** The eval env for a draft before its PR exists: one per desire, so two drafts of one tenant never share rows. */
export const draftEnv = (desireNumber: number): Env => `pr-${990_000 + desireNumber}`;

export async function draftChange(d: DraftDeps, i: DraftInput): Promise<DraftResult> {
  const { compiled: base, files, lock } = i.base;
  const laneOf = (l: Bundle['models'][keyof Bundle['models']]): Lane => ({ model: d.models(l.model), ...(l.reasoning ? { reasoning: l.reasoning } : {}) });
  const patchLane = laneOf(base.bundle.models.patch);
  const turnIds: string[] = [];
  const registered: string[] = [];
  const host = (digest: string, bundle: Bundle) => {
    const observed: HostDeps['observed'] = new Map();
    const observe: Observe = (turnId, tool, output) => { if (turnId) observed.set(turnId, [...(observed.get(turnId) ?? []), { tool, output }]); };
    return evalHost({ control: d.control, tenantId: i.tenantId, env: i.env, digest, bundle, observed, judgeModel: d.jev, turnIds,
                      handleTurn: d.engine({ env: i.env, digest, bundle }, observe) });
  };
  const open = (bundles: Parameters<typeof openEvalEnv>[1]['bundles'], treeFiles: Record<string, string>) =>
    openEvalEnv(d.control, { tenantId: i.tenantId, env: i.env, gitSha: i.base.gitSha, compiler: lock.compiler, bundles, seedDigest: base.digest, files: treeFiles });

  try {
    const agent = Object.values(base.bundle.apps).map((a) => a.agent).find((a) => a && base.bundle.agents[a])!;
    const r = await reproduce(patchLane, i.desire, base.bundle.agents[agent]!.persona);
    const failing: Failing = { suite: 'regressions', id: r.id, yaml: r.yaml, case: r.case };
    registered.push(...(await open([{ digest: base.digest, bundle: base.bundle, projections: base.projections }], files)).inserted);
    const onBase = await runOnce(host(base.digest, base.bundle), r.case, `draft_base_${i.desire.number}`);
    d.log?.('architect.reproduced', { desire: i.desire.number, case: r.id, fails_on_base: !onBase.pass });
    if (onBase.pass) return { outcome: 'no_gap', failing };

    const result = await heal({
      desire: i.desire, base: { files, lock, bundle: base.bundle, digest: base.digest }, failing,
      maxAttempts: base.bundle.governance.architect.maxPatchAttempts,
      draft: (feedback) => draftPatch(patchLane, { desire: i.desire, failingCase: r.yaml, files, feedback }, base.digest),
      verify: async (head, radius) => {
        registered.push(...(await open([{ digest: head.digest, bundle: head.bundle, projections: head.projections }], head.files)).inserted);
        return verify(host(head.digest, head.bundle), selectTests(head, radius, { suite: 'regressions', case: r.case }), r.id,
                      `draft_${head.digest.slice(7, 15)}`);
      },
      ...(d.log ? { log: d.log } : {}),
    });
    if (result.outcome === 'to_developer') return { outcome: 'to_developer', failing, attempts: result.attempts, feedback: result.feedback };
    return { outcome: 'ready', failing, baseFailures: onBase.failures, attempts: result.attempts, changeset: result.changeset,
             head: result.head, radius: result.radius, verification: result.verification };
  } finally {
    // The env's rows and every candidate bundle this draft registered go. A head that becomes a PR is registered
    // again by author.ts, as that PR's verified preview.
    await closeEvalEnv(d.control, { tenantId: i.tenantId, env: i.env, turnIds, unregister: registered });
  }
}

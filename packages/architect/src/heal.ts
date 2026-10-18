// packages/architect/src/heal.ts: reproduce → patch → compile → verify (v3 §7.2). A failed attempt feeds compiler
// errors, conflicts and failing runs into the next one; after max_patch_attempts the desire goes to the developer.
import { blastRadius, compile, CompileFailure, type BlastRadius, type Bundle, type CompileResult, type Lock } from '@archable/compiler';
import type { ChangeSet } from '@archable/schema';
import { apply } from '@archable/spec-writer';
import { ZodError, type z } from 'zod';
import type { EvalCase } from './evals';
import type { DesireBrief } from './patch';
import type { Verification } from './verify';

type ChangeSetT = z.infer<typeof ChangeSet>;
export interface Base { files: Record<string, string>; lock: Lock; bundle: Bundle; digest: string }
export interface Head extends CompileResult { files: Record<string, string> }

export interface HealDeps {
  desire: DesireBrief;
  base: Base;
  failing: { suite: string; id: string; yaml: string; case: EvalCase };
  maxAttempts: number;
  draft(feedback: string[]): Promise<ChangeSetT>;
  verify(head: Head, radius: BlastRadius): Promise<Verification>;
  log?(event: string, data: Record<string, unknown>): void;
}

export type HealResult =
  | { outcome: 'ready'; attempts: number; changeset: ChangeSetT; head: Head; radius: BlastRadius; verification: Verification }
  | { outcome: 'to_developer'; attempts: number; feedback: string[] };

export async function heal(d: HealDeps): Promise<HealResult> {
  let feedback: string[] = [];
  for (let attempt = 1; attempt <= d.maxAttempts; attempt++) {
    let drafted: ChangeSetT;
    try {
      drafted = await d.draft(feedback);
    } catch (e) {
      if (!(e instanceof ZodError)) throw e;                                       // a malformed ChangeSet is feedback
      feedback = e.issues.map((x) => `changeset ${x.path.join('.')}: ${x.message}`);
      d.log?.('architect.invalid_changeset', { attempt, feedback });
      continue;
    }
    const changeset: ChangeSetT = { ...drafted, desire: `D-${d.desire.number}`, base_digest: d.base.digest,
      ops: [...drafted.ops.filter((o) => o.op !== 'add_eval'), { op: 'add_eval', suite: d.failing.suite, id: d.failing.id, yaml: d.failing.yaml }] };
    d.log?.('architect.patch', { attempt, ops: changeset.ops.map((o) => o.op) });

    const applied = apply({ files: d.base.files }, changeset);
    if (applied.outcome === 'conflict') {
      feedback = applied.conflicts.map((c) => `op ${c.op} (${changeset.ops[c.op]?.op ?? '?'}): ${c.message}`);
      d.log?.('architect.conflict', { attempt, feedback });
      continue;
    }
    let compiled: CompileResult;
    try {
      compiled = compile(applied.tree, d.base.lock);
    } catch (e) {
      if (!(e instanceof CompileFailure)) throw e;
      feedback = e.errors.map((x) => `compile: ${x.message}`);
      d.log?.('architect.compile_failed', { attempt, feedback });
      continue;
    }
    const head: Head = { ...compiled, files: applied.tree.files };
    const radius = blastRadius(d.base.bundle.graph, head.bundle.graph, d.base.bundle.risk);
    d.log?.('architect.compiled', { attempt, digest: head.digest, tier: radius.tier });
    const verification = await d.verify(head, radius);
    if (verification.failToPass && verification.passToPass) return { outcome: 'ready', attempts: attempt, changeset, head, radius, verification };
    feedback = Object.entries(verification.suites).flatMap(([suite, s]) => s.cases.flatMap((c) => c.results.filter((r) => !r.pass)
      .slice(0, 2).map((r) => `eval ${suite}/${c.id} failed: ${r.failures.join('; ')}\n${r.transcript}`)));
    d.log?.('architect.verify_failed', { attempt, failToPass: verification.failToPass, passToPass: verification.passToPass });
  }
  return { outcome: 'to_developer', attempts: d.maxAttempts, feedback };
}

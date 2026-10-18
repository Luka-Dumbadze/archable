// packages/architect/src/patch.ts: the two model-written steps of the loop (v3 §7.2). Reproduce turns the desire
// into an eval case; Patch writes a typed ChangeSet. Both are structured output, parsed with zod before use; neither
// decides anything: the compiler, the blast radius, the evals and the approvals do (I3).
import { ChangeSet } from '@archable/schema';
import { generateText, Output, type LanguageModel } from 'ai';
import YAML from 'yaml';
import { z } from 'zod';
import { EvalCase } from './evals';

type Reasoning = NonNullable<Parameters<typeof generateText>[0]['reasoning']>;
export interface Lane { model: LanguageModel; reasoning?: string }
export interface DesireBrief { number: number; statement: string; evidence: string[] }

const lane = (l: Lane) => ({ model: l.model, ...(l.reasoning ? { reasoning: l.reasoning as Reasoning } : {}), maxRetries: 1 });

// ── reproduce ──

const DraftCase = z.object({
  turns: z.array(z.string().min(1)).min(1).max(3).describe('what the customer types, one message per turn'),
  must_be_true: z.array(z.string()).min(1).max(2).describe('yes/no questions about the transcript that must be YES once the request is implemented'),
  must_be_false: z.array(z.string()).max(2).describe('yes/no questions that must be NO, e.g. a promise the business does not make'),
  age_verified: z.boolean().describe('whether the fixture customer is already age-verified'),
});

export const JUDGE = { min: 0.6, max: 0.3 } as const;

const REPRODUCE_RULES = `You write one regression eval case for a business's customer-facing agent.
The case is a short customer conversation plus yes/no questions a judge answers from the transcript alone.
It must FAIL on the business as it is today and PASS once the owner's request is implemented.
- The customer writes the way this business's customers write; if the evidence has no customer text, write English.
- Questions are in English, about what the agent's reply says, answerable from the transcript without other knowledge.
- Do not ask about tool calls, internal systems, or exact wording.`;

export async function reproduce(l: Lane, d: DesireBrief, persona: string): Promise<{ id: string; yaml: string; case: EvalCase }> {
  const { output } = await generateText({
    ...lane(l),
    output: Output.object({ schema: DraftCase }),
    system: REPRODUCE_RULES,
    prompt: `Owner's request (D-${d.number}): ${d.statement}\n\nEvidence:\n${d.evidence.join('\n') || '(none)'}\n\nThe agent's current persona:\n${persona}`,
  });
  const draft = DraftCase.parse(output);
  const id = `d-${d.number}-01`;
  const c = EvalCase.parse({
    id, desire: `D-${d.number}`,
    turns: draft.turns.map((customer) => ({ customer })),
    // Thresholds from the tenant's Jev calibration (evals/calibration, 2026-10-18): true answers ≥ 0.56, false ≤ 0.27.
    // v3 §6.2's example uses 0.9 / 0.2, which Jev's correct answers did not reach (0.84 observed).
    expect: [...draft.must_be_true.map((question) => ({ judge: { question, min: JUDGE.min } })),
             ...draft.must_be_false.map((question) => ({ judge: { question, max: JUDGE.max } }))],
    fixtures: { customer: { phone: '+995555000111', age_verified: draft.age_verified } },
  });
  const yaml = `# ${id}: written by the Architect for D-${d.number}; it failed on the bundle active when the desire was drafted.\n`
    + YAML.stringify(c, { lineWidth: 0 });
  return { id, yaml, case: c };
}

// ── patch ──

const ARCHITECT_RULES = `You are the Architect of a business's operating system. You change its spec, never its code, with
the smallest typed ChangeSet that makes the failing eval case pass without breaking anything else.
Ops (JSON):
- set {path, value, expect}: a scalar at a dotted spec path; expect is its current value, or null if absent.
- add_enum {path: "objects.<object>.fields.<field>", value, label}: label in plain lower-case English words.
- add_field {object, field, type, optional}
- add_policy {file: "<name>.cedar", id, cedar, summary}: Cedar forbid rules only; agent permits are generated. The text
  starts with @id("<id>"). Use "principal is Agent". Money is integer tetri: 300 GEL is 30000. Context available to a
  rule on order.create: context.input.<input> (its inputs), context.quote.total (the priced basket, tetri),
  context.customer.<field>. Follow the style of the existing policies.
- edit_persona {agent, find, replace, summary}: find is one exact, complete line of the persona; replace is that line
  plus what you add. Personas set wording only; facts come from tools.
The agent knows only its persona and its tools' results. A new option or rule the agent must tell customers about
(a payment method, a limit) needs an edit_persona that says it, as well as the spec and policy ops that enforce it.
Every summary is one sentence for the owner, in plain words (no technical terms).
Do not add eval cases (the failing case is added for you). Paths under governance, risk, connections, channels and
runtime are out of reach. At most 8 ops.`;

// The model answers with one flat op shape (every field present, null where unused): OpenAI's structured output
// refuses the `oneOf` a discriminated union becomes. Each op is then parsed into the typed Op of the ChangeSet.
const N = <T extends z.ZodType>(t: T) => t.nullable();
const FlatOp = z.object({
  op: z.enum(['set', 'add_enum', 'add_field', 'add_policy', 'edit_persona', 'add_eval']),
  path: N(z.string()), value: N(z.union([z.string(), z.number(), z.boolean()])), expect: N(z.union([z.string(), z.number(), z.boolean()])),
  label: N(z.string()), object: N(z.string()), field: N(z.string()), type: N(z.string()), optional: N(z.boolean()),
  file: N(z.string()), id: N(z.string()), cedar: N(z.string()), summary: N(z.string()),
  agent: N(z.string()), find: N(z.string()), replace: N(z.string()), suite: N(z.string()), yaml: N(z.string()),
});
const Draft = z.object({ rationale: z.string(), ops: z.array(FlatOp).min(1).max(12) });
const KEEP_NULL = new Set(['expect']);                 // set.expect is nullable in the ChangeSet itself
const typed = (o: z.infer<typeof FlatOp>) => Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== null || (KEEP_NULL.has(k) && o.op === 'set')));

export interface PatchContext {
  desire: DesireBrief;
  failingCase: string;                                 // its YAML
  files: Record<string, string>;                       // spec, policies, personas
  feedback: string[];                                  // compiler errors, conflicts and failing runs from the last attempt
}

export async function draftPatch(l: Lane, p: PatchContext, baseDigest: string): Promise<z.infer<typeof ChangeSet>> {
  const shown = Object.entries(p.files).filter(([path]) => path === 'enterprise.spec.yaml' || /^(policies|personas)\//.test(path))
    .sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, text]) => `--- ${path}\n${text}`).join('\n');
  const { output } = await generateText({
    ...lane(l),
    output: Output.object({ schema: Draft }),
    system: ARCHITECT_RULES,
    prompt: [`Desire D-${p.desire.number}: ${p.desire.statement}`, `Evidence:\n${p.desire.evidence.join('\n') || '(none)'}`,
             `Failing eval case:\n${p.failingCase}`, `The repository:\n${shown}`,
             ...(p.feedback.length ? [`Your last attempt failed:\n${p.feedback.join('\n')}`] : [])].join('\n\n'),
  });
  const d = Draft.parse(output);
  return ChangeSet.parse({ rationale: d.rationale.slice(0, 600), ops: d.ops.map(typed), desire: `D-${p.desire.number}`, base_digest: baseDigest });
}

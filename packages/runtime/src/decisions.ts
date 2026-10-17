// packages/runtime/src/decisions.ts: one Jev request per stage (plan §5.2, v3 §7.1). Routing fails open (null:
// the dialogue model routes itself); pre-send fails closed (FAILED: Cedar denies message.send). I7.
//
// Field names checked against ai 7.0.143 / @ai-sdk/gateway 4.0.116 (plan §10.1 item 1). Differences from the
// plan's sketch: Choice and Score questions take `criteria` (not `options` / `scale`) and require
// `instructions`; a Choice answer has `probabilities` (no `confidence`); a Score answer is a fractional level
// index; a refused question makes decide() throw DecisionRefusalError.
import { gateway } from '@ai-sdk/gateway';
import { digestOf, type Bundle } from '@archable/compiler';
import { experimental_decide, type JSONValue } from 'ai';
import type { InTenant } from './db';

// ── decision heads, as compiled from the spec (v3 §6 decisions) ──

interface ChoiceHead { kind: 'choice'; instructions?: string; criteria: Record<string, string>; escalate?: { confidence_below?: number } }
interface ScoreHead { kind: 'score'; instructions?: string; criteria: string[]; capture_failure_at?: string }
interface BooleanHead { kind: 'boolean'; instructions: string; pass_at?: number; block_at?: number; escalate?: { probability_between?: [number, number] } }

// route.intent carries no instructions in the spec; decide() requires them.
const INTENT_INSTRUCTIONS = 'Which option best describes what the customer wants in their latest message?';

function head<T extends { kind: string }>(bundle: Bundle, id: string, kind: T['kind']): T {
  const h = bundle.decisions[id] as T | undefined;
  if (!h || h.kind !== kind) throw new Error(`decision head ${id} (${kind}) missing from the bundle`);
  return h;
}

// ── shapes ──

export interface Msg { author: string; body: string }               // 'customer' | 'agent:…' | 'staff:…'
export interface RouteInput { tenantId: string; turnId: string; text: string }
export interface Route {
  intent: string;                                                   // a route.intent criteria key
  confidence: number | null;                                        // P(intent), when the model returns a distribution
  frustration: string;                                              // a turn.signals level
  answeredBy: string;                                               // Jev, or the fallback that answered
}

export interface Draft {
  tenantId: string;
  turnId: string;
  text: string;
  digest: string;                                                   // sha256 of text; signals are bound to it
  evidence: JSONValue;                                              // tool outputs this turn
  inReplyTo: string;                                                // the customer's message
}
export interface Signal { verdict: 'pass' | 'fail'; p: number | null; payload_digest: string }
export interface Signals { grounded: Signal; commitment: Signal; answeredBy: string }

/** What Cedar sees when pre-send could not run: no verdict passes and no digest matches a draft. */
export const FAILED: Signals = Object.freeze({
  grounded: { verdict: 'fail', p: null, payload_digest: '' },
  commitment: { verdict: 'fail', p: null, payload_digest: '' },
  answeredBy: 'none',
}) as Signals;

export interface DecisionRow {
  tenant_id: string;
  turn_id: string;
  head: string;
  stage: 'route' | 'pre_send';
  model: string;
  fallback: boolean;
  input_digest: string;
  answer: Record<string, unknown>;
  verdict: string;
  latency_ms: number;
}
export type DecisionLog = (rows: DecisionRow[]) => Promise<void>;

export const PRIMARY = 'typesafe-ai/jev';

export function createDecisionLog(inTenant: InTenant): DecisionLog {
  return async (rows) => {
    if (!rows.length) return;
    await inTenant(rows[0]!.tenant_id, async (tx) => {
      await tx`insert into public.decision_log ${tx(rows.map((r) => ({ ...r, answer: tx.json(r.answer as never) })) as never)}`;
    });
  };
}

// ── deadline ──

export class DeadlineExceeded extends Error {
  constructor(readonly ms: number) {
    super(`decision deadline of ${ms} ms exceeded`);
    this.name = 'DeadlineExceeded';
  }
}

async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { ctl.abort(); reject(new DeadlineExceeded(ms)); }, ms);
  });
  try {
    return await Promise.race([run(ctl.signal), deadline]);           // the race holds even if a provider ignores abort
  } finally {
    clearTimeout(timer);
  }
}

// ── the two stages ──

type Decide = typeof experimental_decide;

export interface DecisionDeps {
  decide?: Decide;                                                  // tests inject a fake
  log: DecisionLog;
  now?: () => number;
}

export function createDecisions(d: DecisionDeps) {
  const decide = d.decide ?? experimental_decide;
  const now = d.now ?? (() => performance.now());
  const logged = (rows: DecisionRow[]) => { void d.log(rows).catch(() => {}); };   // evidence, never on the critical path

  async function route(bundle: Bundle, inbound: RouteInput, tail: Msg[]): Promise<Route | null> {
    const t0 = now();
    const state = { message: inbound.text, recent: tail.slice(-6).map((m) => `${m.author}: ${m.body}`).join('\n') };
    const row = (model: string, fallback: boolean, answer: Record<string, unknown>, verdict: string): DecisionRow => ({
      tenant_id: inbound.tenantId, turn_id: inbound.turnId, head: 'route.intent', stage: 'route', model, fallback,
      input_digest: digestOf(state), answer, verdict, latency_ms: Math.round(now() - t0),
    });
    try {
      const intent = head<ChoiceHead>(bundle, 'route.intent', 'choice');
      const signals = head<ScoreHead>(bundle, 'turn.signals', 'score');
      const r = await withDeadline((abortSignal) => decide({
        model: gateway.decisionModel(PRIMARY),
        state,
        questions: {
          intent: { type: 'choice', instructions: intent.instructions ?? INTENT_INSTRUCTIONS, criteria: intent.criteria },
          frustration: { type: 'score', instructions: signals.instructions ?? '', criteria: signals.criteria },
        },
        providerOptions: intent.escalate?.confidence_below !== undefined && bundle.models.decision.fallback
          ? { gateway: { models: [{ model: bundle.models.decision.fallback,
                                    when: { question: 'intent', confidenceBelow: intent.escalate.confidence_below } }] } }
          : undefined,
        abortSignal,
        maxRetries: 0,                                              // the deadline is the budget; no retries inside it
      }), bundle.deadlines.route);
      const level = Math.min(signals.criteria.length - 1, Math.max(0, Math.round(r.answers.frustration.score)));
      const out: Route = {
        intent: r.answers.intent.choice,
        confidence: r.answers.intent.probabilities?.[r.answers.intent.choice] ?? null,
        frustration: signals.criteria[level]!,
        answeredBy: r.response.modelId,
      };
      logged([row(out.answeredBy, out.answeredBy !== PRIMARY, { intent: r.answers.intent, frustration: r.answers.frustration }, out.intent)]);
      return out;
    } catch (e) {
      logged([row(PRIMARY, false, { error: String(e) }, e instanceof DeadlineExceeded ? 'timeout' : 'error')]);
      return null;                                                  // I7: the dialogue model routes itself
    }
  }

  async function preSend(bundle: Bundle, draft: Draft): Promise<Signals> {
    const t0 = now();
    const state = { reply: draft.text, evidence: draft.evidence, customer_message: draft.inReplyTo };
    const rows = (model: string, fallback: boolean, answers: Record<string, Record<string, unknown>>, verdicts: [string, string]) =>
      (['send.grounded', 'send.commitment'] as const).map((h, i): DecisionRow => ({
        tenant_id: draft.tenantId, turn_id: draft.turnId, head: h, stage: 'pre_send', model, fallback,
        input_digest: digestOf({ ...state, payload_digest: draft.digest }), answer: answers[h] ?? {},
        verdict: verdicts[i]!, latency_ms: Math.round(now() - t0),
      }));
    try {
      const grounded = head<BooleanHead>(bundle, 'send.grounded', 'boolean');
      const commitment = head<BooleanHead>(bundle, 'send.commitment', 'boolean');
      if (grounded.pass_at === undefined || commitment.block_at === undefined) throw new Error('pre-send thresholds missing');
      const when = [
        ...(grounded.escalate?.probability_between ? [{ question: 'grounded' as const, probabilityBetween: grounded.escalate.probability_between }] : []),
        ...(commitment.escalate?.probability_between ? [{ question: 'commitment' as const, probabilityBetween: commitment.escalate.probability_between }] : []),
      ];
      const r = await withDeadline((abortSignal) => decide({
        model: gateway.decisionModel(PRIMARY),
        state,
        questions: {
          grounded: { type: 'boolean', instructions: grounded.instructions },
          commitment: { type: 'boolean', instructions: commitment.instructions },
        },
        providerOptions: when.length && bundle.models.decision.fallback
          ? { gateway: { models: [{ model: bundle.models.decision.fallback, when: { any: when as [typeof when[0], ...typeof when] } }] } }
          : undefined,
        abortSignal,
        maxRetries: 0,
      }), bundle.deadlines.pre_send);
      const g = r.answers.grounded.probability;
      const c = r.answers.commitment.probability;
      const out: Signals = {
        grounded: { verdict: g >= grounded.pass_at ? 'pass' : 'fail', p: g, payload_digest: draft.digest },
        commitment: { verdict: c < commitment.block_at ? 'pass' : 'fail', p: c, payload_digest: draft.digest },
        answeredBy: r.response.modelId,
      };
      logged(rows(out.answeredBy, out.answeredBy !== PRIMARY,
        { 'send.grounded': { probability: g }, 'send.commitment': { probability: c } },
        [out.grounded.verdict, out.commitment.verdict]));
      return out;
    } catch (e) {
      const verdict = e instanceof DeadlineExceeded ? 'timeout' : 'error';
      logged(rows(PRIMARY, false, { 'send.grounded': { error: String(e) }, 'send.commitment': { error: String(e) } }, [verdict, verdict]));
      return FAILED;                                                // I7: the draft is not sent
    }
  }

  return { route, preSend, FAILED };
}

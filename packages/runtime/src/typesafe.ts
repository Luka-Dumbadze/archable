// packages/runtime/src/typesafe.ts: Jev through TypeSafe's own API (POST https://api.typesafe.ai/v1/systemone), as an
// AI SDK decision model, so experimental_decide and decisions.ts are unchanged. Used when TYPESAFE_API_KEY is set:
// AI Gateway's free tier serves neither Jev nor BYOK (PROGRESS.md Q5). Wire format from docs.typesafe.ai/api.
import type { Experimental_DecisionModelV4 } from '@ai-sdk/provider';

type V4 = Experimental_DecisionModelV4;
type CallOptions = Parameters<V4['doDecide']>[0];
type Result = Awaited<ReturnType<V4['doDecide']>>;

export const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
export const TYPESAFE_MODEL = 'jev-latest';

type Answer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities?: Record<string, number>; confidence?: number }
  | { type: 'score'; score: number; probabilities?: Record<string, number>; confidence?: number };

export class TypeSafeError extends Error {
  constructor(readonly status: number, body: string) {
    super(`TypeSafe ${status}: ${body.slice(0, 200)}`);
    this.name = 'TypeSafeError';
  }
}

/** TypeSafe takes state as a string, an object or an array; the SDK hands over parts. */
function stateOf(parts: CallOptions['state']): unknown {
  if (parts.length === 1) {
    const p = parts[0]!;
    if (p.type === 'json') return p.value;
    if (p.type === 'text') return p.text;
  }
  return parts.map((p) => (p.type === 'json' ? p.value : p.type === 'text' ? p.text : { type: p.type }));
}

export function typesafeDecisionModel(o: { apiKey: string; model?: string; url?: string; fetch?: typeof fetch }): V4 {
  const model = o.model ?? TYPESAFE_MODEL;
  const doFetch = o.fetch ?? fetch;
  return {
    specificationVersion: 'v4',
    provider: 'typesafe',
    modelId: model,
    supportedQuestionTypes: ['boolean', 'choice', 'score'],
    async doDecide(call: CallOptions): Promise<Result> {
      const questions = Object.fromEntries(Object.entries(call.questions).map(([id, q]) => {
        if (q.type === 'boolean') return [id, { type: 'noul', instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) }];
        if (q.type === 'box') throw new Error('box questions are not supported by TypeSafe');
        return [id, { type: q.type, instructions: q.instructions, criteria: q.criteria }];
      }));
      const res = await doFetch(o.url ?? TYPESAFE_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${o.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, state: stateOf(call.state), questions }),
        ...(call.abortSignal ? { signal: call.abortSignal } : {}),
      });
      if (!res.ok) throw new TypeSafeError(res.status, await res.text().catch(() => ''));
      const body = await res.json() as { model?: string; answers: Record<string, Answer>; usage?: { input_tokens?: number; output_tokens?: number } };
      const answers: Result['answers'] = {};
      for (const [id, a] of Object.entries(body.answers ?? {})) {
        answers[id] = a.type === 'noul' ? { type: 'boolean', probability: a.noul }
          : a.type === 'choice' ? { type: 'choice', choice: a.choice, ...(a.probabilities ? { probabilities: a.probabilities } : {}) }
          : { type: 'score', score: a.score, ...(a.probabilities ? { probabilities: a.probabilities } : {}) };
      }
      // TypeSafe rounds its numbers (2 decimals observed); the SDK checks a score against the probability-weighted
      // mean and allows half a unit per rounded value only when the result declares the precision.
      const decimals = (xs: number[]) => Math.max(0, ...xs.map((x) => (String(x).split('.')[1] ?? '').length));
      const all = Object.values(body.answers ?? {});
      const probs = all.flatMap((a) => (a.type === 'noul' ? [a.noul] : Object.values(a.probabilities ?? {})));
      const scores = all.flatMap((a) => (a.type === 'score' ? [a.score] : []));
      return {
        answers,
        rounding: { probabilityDecimals: decimals(probs), scoreDecimals: decimals(scores) },
        warnings: [],
        usage: { inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens },
        response: { modelId: `typesafe/${body.model ?? model}`, timestamp: new Date() },
      };
    },
  };
}

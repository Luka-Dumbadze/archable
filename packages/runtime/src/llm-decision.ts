// packages/runtime/src/llm-decision.ts: a language model as a decision model, for settling Jev's unsure answers when
// Jev is called directly (PROGRESS.md Q5). Like AI Gateway's language-model fallback (v3 §1.1), it answers through
// structured output and returns no confidence: a Choice gets no probabilities, a Score a whole level.
import type { Experimental_DecisionModelV4 } from '@ai-sdk/provider';
import { generateText, jsonSchema, Output, type JSONSchema7, type LanguageModel } from 'ai';

type V4 = Experimental_DecisionModelV4;
type CallOptions = Parameters<V4['doDecide']>[0];
type Result = Awaited<ReturnType<V4['doDecide']>>;

const SYSTEM = 'You are a careful, literal judge. Answer each question about the state only from what the state contains. '
  + 'For a yes/no question give the probability that the answer is yes, from 0 to 1.';

export function llmDecisionModel(o: { model: LanguageModel; modelId: string; generate?: typeof generateText }): V4 {
  const generate = o.generate ?? generateText;
  return {
    specificationVersion: 'v4',
    provider: 'llm',
    modelId: o.modelId,
    supportedQuestionTypes: ['boolean', 'choice', 'score'],
    async doDecide(call: CallOptions): Promise<Result> {
      const properties: Record<string, unknown> = {};
      const described: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(call.questions)) {
        if (q.type === 'boolean') {
          properties[id] = { type: 'number', minimum: 0, maximum: 1 };
          described[id] = { type: 'yes/no', question: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) };
        } else if (q.type === 'choice') {
          properties[id] = { type: 'string', enum: Object.keys(q.criteria) };
          described[id] = { type: 'pick one option', question: q.instructions, options: q.criteria };
        } else if (q.type === 'score') {
          properties[id] = { type: 'integer', minimum: 0, maximum: q.criteria.length - 1 };
          described[id] = { type: 'pick a level index', question: q.instructions, levels: Object.fromEntries(q.criteria.map((c, i) => [i, c])) };
        } else throw new Error('box questions are not supported by the language-model fallback');
      }
      const state = call.state.map((p) => (p.type === 'json' ? p.value : p.type === 'text' ? p.text : { type: p.type }));
      const r = await generate({
        model: o.model,
        system: SYSTEM,
        prompt: JSON.stringify({ state: state.length === 1 ? state[0] : state, questions: described }),
        output: Output.object({ schema: jsonSchema<Record<string, number | string>>({
          type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
        } as JSONSchema7) }),
        maxRetries: 0,
        ...(call.abortSignal ? { abortSignal: call.abortSignal } : {}),
      });
      const out = r.output as Record<string, number | string>;
      const answers: Result['answers'] = {};
      for (const [id, q] of Object.entries(call.questions)) {
        const v = out[id];
        answers[id] = q.type === 'boolean' ? { type: 'boolean', probability: Math.min(1, Math.max(0, Number(v))) }
          : q.type === 'choice' ? { type: 'choice', choice: String(v) }
          : { type: 'score', score: Math.round(Number(v)) };
      }
      return {
        answers,
        warnings: [],
        usage: { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens },
        response: { modelId: o.modelId, timestamp: new Date() },
      };
    },
  };
}

// apps/api/src/turn-wiring.ts: the turn engine with its real dependencies. Every query runs as archable_runtime
// (runtimeDb) inside the tenant's RLS context. Models, per PROGRESS.md Q5: Jev directly through TypeSafe when
// TYPESAFE_API_KEY is set (else through AI Gateway); language models directly through their providers when a key is
// set (google/… with GEMINI_API_KEY, openai/… with OPENAI_API_KEY), else through AI Gateway. In direct mode the
// spec's models.decision.fallback, a language model, settles Jev's unsure answers through structured output.
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { gateway } from '@ai-sdk/gateway';
import { createOpenAI } from '@ai-sdk/openai';
import { createExecutors, createFacts, createQuotes } from '@archable/gateway';
import {
  createBundles, createContext, createDecisionLog, createDecisions, createEpochs, createHandleTurn, createStore,
  llmDecisionModel, typesafeDecisionModel, type Deliver, type HandleTurn, type InTenant,
} from '@archable/runtime';
import type { LanguageModel } from 'ai';
import { runtimeDb, withTenant } from './db';

export function createTurnEngine(o: { deliver?: Deliver } = {}): HandleTurn {
  const inTenant: InTenant = (tenantId, fn) => withTenant(runtimeDb, tenantId, fn);
  const google = process.env.GEMINI_API_KEY ? createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
  const openai = process.env.OPENAI_API_KEY ? createOpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
  const executors = createExecutors(inTenant);

  // 'google/gemini-3.6-flash' → Google; 'openai/gpt-6-luna' → OpenAI; anything else, or no key, through AI Gateway.
  const languageModel = (slug: string): LanguageModel => {
    if (google && slug.startsWith('google/')) return google(slug.slice('google/'.length));
    if (openai && slug.startsWith('openai/')) return openai(slug.slice('openai/'.length));
    return gateway(slug);
  };

  return createHandleTurn({
    epochs: createEpochs(inTenant),
    bundles: createBundles(inTenant),
    context: createContext(inTenant),
    decisions: createDecisions({
      log: createDecisionLog(inTenant),
      ...(process.env.TYPESAFE_API_KEY ? {
        primary: typesafeDecisionModel({ apiKey: process.env.TYPESAFE_API_KEY }),
        fallback: (slug: string) => llmDecisionModel({ model: languageModel(slug), modelId: slug }),
      } : {}),
    }),
    store: createStore(inTenant),
    gateway: { inTenant, facts: createFacts(inTenant), quotes: createQuotes(executors), executors },
    languageModel,
    deliver: o.deliver ?? (async () => { throw new Error('Telegram delivery is wired in Phase 3 (DEV-1, send.ts)'); }),
  });
}

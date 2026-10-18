// apps/api/src/turn-wiring.ts: the turn engine with its real dependencies. Every query runs as archable_runtime
// (runtimeDb) inside the tenant's RLS context. Models, per PROGRESS.md Q5: Jev directly through TypeSafe when
// TYPESAFE_API_KEY is set (else through AI Gateway); language models directly through their providers when a key is
// set (google/… with GEMINI_API_KEY, openai/… with OPENAI_API_KEY), else through AI Gateway. In direct mode the
// spec's models.decision.fallback, a language model, settles Jev's unsure answers through structured output.
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { gateway } from '@ai-sdk/gateway';
import { createOpenAI } from '@ai-sdk/openai';
import { createExecutors, createFacts, createQuotes, type NotifyDeliver } from '@archable/gateway';
import {
  createBundles, createContext, createDecisionLog, createDecisions, createEpochs, createHandleTurn, createStore,
  createTriggerDrain, llmDecisionModel, typesafeDecisionModel, type Deliver, type HandleTurn, type InTenant, type TriggerJob,
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

/** The trigger drain (P3.D2.3) on runtimeDb; the cron route that calls it on a schedule is P4.D2.8. */
export function createTriggerDrainer(o: { deliver?: NotifyDeliver } = {}) {
  const inTenant: InTenant = (tenantId, fn) => withTenant(runtimeDb, tenantId, fn);
  const executors = createExecutors(inTenant, o);
  return createTriggerDrain({
    queue: {
      read: (qty) => runtimeDb<{ msg_id: number; read_ct: number; message: TriggerJob }[]>`select msg_id, read_ct, message from private.triggers_read(${qty})`,
      archive: async (id) => { await runtimeDb`select private.triggers_archive(${id})`; },
    },
    bundles: createBundles(inTenant),
    gateway: { inTenant, facts: createFacts(inTenant), quotes: createQuotes(executors), executors },
  });
}

// apps/api/src/turn-wiring.ts: the turn engine with its real dependencies. Every query runs as archable_runtime
// (runtimeDb) inside the tenant's RLS context. Models, per PROGRESS.md Q5: Jev directly through TypeSafe when
// TYPESAFE_API_KEY is set (else through AI Gateway), and the dialogue model directly through Google with GEMINI_API_KEY.
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { gateway } from '@ai-sdk/gateway';
import { createExecutors, createFacts, createQuotes } from '@archable/gateway';
import {
  createBundles, createContext, createDecisionLog, createDecisions, createEpochs, createHandleTurn, createStore,
  typesafeDecisionModel, type Deliver, type HandleTurn, type InTenant,
} from '@archable/runtime';
import type { LanguageModel } from 'ai';
import { runtimeDb, withTenant } from './db';

export function createTurnEngine(o: { deliver?: Deliver } = {}): HandleTurn {
  const inTenant: InTenant = (tenantId, fn) => withTenant(runtimeDb, tenantId, fn);
  const google = process.env.GEMINI_API_KEY ? createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
  const executors = createExecutors(inTenant);

  return createHandleTurn({
    epochs: createEpochs(inTenant),
    bundles: createBundles(inTenant),
    context: createContext(inTenant),
    decisions: createDecisions({
      log: createDecisionLog(inTenant),
      ...(process.env.TYPESAFE_API_KEY ? { primary: typesafeDecisionModel({ apiKey: process.env.TYPESAFE_API_KEY }) } : {}),
    }),
    store: createStore(inTenant),
    gateway: { inTenant, facts: createFacts(inTenant), quotes: createQuotes(executors), executors },
    // 'google/gemini-3.8-flash' → Google's 'gemini-3.8-flash'; other slugs still go through AI Gateway.
    languageModel: (slug): LanguageModel => (google && slug.startsWith('google/') ? google(slug.slice('google/'.length)) : gateway(slug)),
    deliver: o.deliver ?? (async () => { throw new Error('Telegram delivery is wired in Phase 3 (DEV-1, send.ts)'); }),
  });
}

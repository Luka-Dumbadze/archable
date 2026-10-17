// packages/runtime/src/turn.ts: handleTurn (v3 §7.1, amended in plan §5.4). One pinned digest per turn; Cedar decides
// every tool call and the send; a draft that isn't grounded becomes a holding reply plus a staff handoff (I3, I7).
// Amendments: [1] a TurnResult, [2] a paused conversation stores the message and stops, [3] the reply goes through
// the ReplyTarget, [4] Business suggest mode is the sender's concern (DEV-1's deliver).
import type { Bundle } from '@archable/compiler';
import { toolGateway, type GatewayDeps } from '@archable/gateway';
import { generateText, stepCountIs, type LanguageModel } from 'ai';
import { agentFor, holdingReply, systemPrompt } from './agent';
import type { ContextOptions, TurnContext } from './context';
import type { Draft, Msg, Route, RouteInput, Signals } from './decisions';
import { FAILED } from './decisions';
import { draftOf } from './drafts';
import type { Pin } from './epochs';
import type { Conversation, Store } from './store';
import type { Deliver, HandleTurn, Inbound } from './types';

type Reasoning = NonNullable<Parameters<typeof generateText>[0]['reasoning']>;

export interface TurnDeps {
  epochs: { pin(tenantId: string, env: Inbound['env']): Promise<Pin> };
  bundles: { load(tenantId: string, digest: string): Promise<Bundle> };
  context: { load(tenantId: string, pin: Pin, conv: Conversation, o: ContextOptions): Promise<TurnContext> };
  decisions: { route(b: Bundle, i: RouteInput, tail: Msg[]): Promise<Route | null>; preSend(b: Bundle, d: Draft): Promise<Signals> };
  store: Store;
  gateway: GatewayDeps;
  languageModel(slug: string): LanguageModel;                   // 'google/gemini-3.8-flash' → a provider model (Q5)
  deliver: Deliver;                                             // Telegram: DEV-1's sender; web and console are recorded here
  generate?: typeof generateText;                               // tests inject a fake model loop
}

const rank = (scale: string[], level: string | undefined) => (level ? scale.indexOf(level) : -1);

export function createHandleTurn(d: TurnDeps): HandleTurn {
  const generate = d.generate ?? generateText;

  return async (inbound) => {
    const { tenantId, turnId } = inbound;
    const pin = await d.epochs.pin(tenantId, inbound.env);                       // one indexed read
    const bundle = await d.bundles.load(tenantId, pin.digest);
    const conv = await d.store.upsertConversation(inbound);
    const inId = await d.store.insertInbound(conv, inbound, pin.digest);         // unique external_id: retries stop here
    if (inId === null) return d.store.replyFor(conv, inbound);                   // [1] duplicate delivery: same answer
    if (conv.agent_paused_until && conv.agent_paused_until > new Date()) {       // [2] a person is answering
      return { turnId, text: '', allowed: false, outboundMessageId: 0, paused: true };
    }

    const agentId = agentFor(bundle, inbound);
    const agent = bundle.agents[agentId]!;
    const locale = String((bundle.metadata.locale as { primary?: string } | null)?.primary ?? 'en');
    const tail = Number((agent.context as { conversation_tail?: number } | null)?.conversation_tail ?? 20);
    const [route, ctx] = await Promise.all([
      d.decisions.route(bundle, inbound, conv.tail),                             // fails open: null
      d.context.load(tenantId, pin, conv, { tail, locale }),
    ]);
    const chapterId = await d.store.ensureChapter(tenantId, inbound.env, conv, route?.intent ?? 'other', conv.customer_id);

    const gw = toolGateway({
      tenantId, turnId, pin, bundle, principal: { type: 'Agent', id: agentId }, chapterId,
      session: { channel: inbound.reply.kind === 'console' ? 'console' : inbound.channel, linkedCustomerId: conv.customer_id },
    }, d.gateway);

    const lane = bundle.models.dialogue;
    let stepAt = performance.now();
    const result = await generate({
      // One JSON line per model step (plan §9.2): timing, tool names, token counts. Never message text.
      onStepFinish: (s) => {
        const now = performance.now();
        console.log(JSON.stringify({ event: 'turn.step', tenant: tenantId, turn_id: turnId, ms: Math.round(now - stepAt),
          outcome: s.finishReason, tools: s.toolCalls.map((t) => t.toolName), tokens: { in: s.usage.inputTokens, out: s.usage.outputTokens } }));
        stepAt = now;
      },
      model: d.languageModel(lane.model),
      ...(lane.reasoning ? { reasoning: lane.reasoning as Reasoning } : {}),
      system: systemPrompt(bundle, agentId, route, ctx),
      messages: ctx.messages,
      tools: gw.tools,
      stopWhen: stepCountIs(4),
      abortSignal: AbortSignal.timeout(bundle.deadlines.dialogue),
      maxRetries: 0,
    }).catch((e: unknown) => ({ text: '', error: e }));                         // a model failure is a holding reply
    if ('error' in result) {
      await d.store.captureFailure(tenantId, turnId, 'deadline', 3, { stage: 'dialogue', error: String(result.error) }).catch(() => {});
    }

    const draft = draftOf(bundle, result.text.trim(), gw.evidence(), { tenantId, turnId, inReplyTo: inbound.text });
    const signals = draft.text ? await d.decisions.preSend(bundle, draft) : FAILED;  // fails closed
    const verdict = gw.authorize('message.send', { payload_digest: draft.digest, signals });
    const text = verdict.allow ? draft.text : holdingReply(ctx.locale);

    const outId = inbound.reply.kind === 'console' || inbound.reply.kind === 'web'   // [3] the HTTP response is the delivery
      ? await d.store.insertOutbound(tenantId, conv, chapterId, turnId, `agent:${agentId}`, text, pin.digest)
      : await d.deliver(inbound.reply, text, { suggestion: verdict.allow ? draft.text : null });   // [4]

    if (!verdict.allow) {
      await d.store.captureFailure(tenantId, turnId, 'grounding_block', 3, { draft: { text: draft.text, digest: draft.digest }, signals, verdict });
      await gw.call('handoff.staff', { reason: 'reply blocked by pre-send check', urgency: 'normal' });
    }
    const scale = (bundle.decisions['turn.signals'] as { criteria?: string[]; capture_failure_at?: string } | undefined);
    if (route && scale?.criteria && rank(scale.criteria, route.frustration) >= rank(scale.criteria, scale.capture_failure_at) && scale.capture_failure_at) {
      await d.store.captureFailure(tenantId, turnId, 'customer_frustration', 2, { turn: turnId, level: route.frustration });
    }
    return { turnId, text, allowed: verdict.allow, outboundMessageId: outId, paused: false };
  };
}

// packages/gateway/src/gateway.ts: the only path from a model, or a trigger, to a side effect (v3 §7.1, amended in
// plan §5.5). Every call is decided by Cedar, logged to tool_calls, and on success writes its chapter facts in the
// same transaction as its log row, so a rationale can never cite a quote that wasn't logged.
import { digestOf, type Bundle } from '@archable/compiler';
import type { Env } from '@archable/contracts';
import { jsonSchema, tool, type JSONSchema7, type Tool } from 'ai';
import { cedarDecide, contextType, project, type Principal, type Verdict } from './cedar';
import type { InTenant, Tx } from './db';
import type { CallSession, PolicyFacts } from './facts';
import { simulate } from './simulate';

export type ToolOutput = Record<string, unknown>;
export type Executor = (input: Record<string, unknown>, ctx: { tenantId: string; env: Env; digest: string; bundle: Bundle }) => Promise<ToolOutput>;

/** A tool schema as the dialogue model sees it: Archable's annotations and read-only fields removed. */
export function modelSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(modelSchema);
  if (!s || typeof s !== 'object') return s;
  const o = s as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k.startsWith('x-') || k === 'readOnly') continue;
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v as Record<string, Record<string, unknown>>)
        .filter(([, p]) => !p.readOnly).map(([name, p]) => [name, modelSchema(p)]));
    } else out[k] = modelSchema(v);
  }
  if (Array.isArray(out.required) && out.properties) out.required = (out.required as string[]).filter((r) => r in (out.properties as object));
  return out;
}

export interface GatewayDeps {
  inTenant: InTenant;
  facts: { forPolicy(tenantId: string, env: Env, bundle: Bundle, tool: string, input: Record<string, unknown>, s: CallSession): Promise<PolicyFacts> };
  quotes: { price(tenantId: string, pin: { env: Env; digest: string }, input: Record<string, unknown>, bundle: Bundle): Promise<ToolOutput> };
  executors: Record<string, Executor>;                        // tool id → implementation (catalog, orders, couriers…)
  connectionsMode?: 'live' | 'simulate';                      // default: process.env.CONNECTIONS_MODE
  now?: () => number;
}

export interface GatewayCtx {
  tenantId: string;
  turnId: string | null;
  pin: { env: Env; digest: string };
  bundle: Bundle;
  principal: Principal;                                       // Agent::"<id>" for turns, Trigger::"<id>" for triggers
  chapterId: string | null;
  session: CallSession;
}

export type CallResult = ToolOutput | { denied: true; policies: string[] } | { error: 'tool_unavailable' };

interface Evidence { tool: string; input: Record<string, unknown>; output: ToolOutput }

class DeadlineExceeded extends Error {}
async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeadlineExceeded(`tool deadline ${ms} ms`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

export function toolGateway(ctx: GatewayCtx, d: GatewayDeps) {
  const { tenantId, turnId, pin, bundle, principal, chapterId, session } = ctx;
  const now = d.now ?? (() => performance.now());
  const mode = d.connectionsMode ?? (process.env.CONNECTIONS_MODE === 'simulate' ? 'simulate' : 'live');
  const caller = `${principal.type === 'Agent' ? 'agent' : 'trigger'}:${principal.id}`;   // A2A inspector reads this
  const evidence: Evidence[] = [];

  const authorize = (action: string, context: Record<string, unknown>): Verdict =>
    cedarDecide(bundle.policies, principal, action, project(contextType(bundle.policies, action), context) as Record<string, unknown>);

  const logCall = (tx: Tx, toolId: string, input: Record<string, unknown>, verdict: Verdict, status: 'ok' | 'error' | 'denied' | 'simulated', ms: number) =>
    tx`insert into public.tool_calls (tenant_id, turn_id, env, caller, tool, args_digest, decision, policies, status, latency_ms)
       values (${tenantId}, ${turnId}, ${pin.env}, ${caller}, ${toolId}, ${digestOf(input)}, ${verdict.allow ? 'allow' : 'deny'},
               ${verdict.reasons}, ${status}, ${Math.round(ms)})`;

  async function call(id: string, rawInput: Record<string, unknown>): Promise<CallResult> {
    const t0 = now();
    const c = bundle.tools[id];
    if (!c) return { denied: true, policies: ['unknown_tool'] };

    let verdict: Verdict;
    let policyFacts: PolicyFacts = { input: rawInput, context: { approvals: [] } };
    try {
      policyFacts = await d.facts.forPolicy(tenantId, pin.env, bundle, id, rawInput, session);   // [a]
      const quote = c.needsQuote ? await d.quotes.price(tenantId, pin, policyFacts.input, bundle) : undefined;
      verdict = authorize(c.action, { input: policyFacts.input, quote, ...policyFacts.context });
    } catch {
      verdict = { allow: false, reasons: ['facts_unavailable'] };        // no facts, no decision: deny
    }
    const input = policyFacts.input;
    if (!verdict.allow) {
      await d.inTenant(tenantId, (tx) => logCall(tx, id, input, verdict, 'denied', now() - t0));
      return { denied: true, policies: verdict.reasons };              // the model can explain or hand off
    }

    const simulated = (pin.env !== 'prod' || mode === 'simulate') && (c.effect === 'external' || c.effect === 'money');   // [b]
    try {
      const run = d.executors[id];
      if (!simulated && !run) throw new Error(`no executor for ${id}`);
      const out = simulated ? simulate(c, input) : await withDeadline(run!(input, { tenantId, env: pin.env, digest: pin.digest, bundle }), bundle.deadlines.tool);
      await d.inTenant(tenantId, async (tx) => {                       // [c] one transaction
        await logCall(tx, id, input, verdict, simulated ? 'simulated' : 'ok', now() - t0);
        if (chapterId && id === 'order.quote' && typeof out.total === 'number') {
          await tx`update public.chapters set last_quote_total = ${out.total}, last_quote_at = now()
                    where tenant_id = ${tenantId} and id = ${chapterId}`;
        }
        const order = out.order as { id?: unknown } | undefined;
        if (chapterId && id === 'order.create' && typeof order?.id === 'string') {
          await tx`update public.chapters set order_id = ${order.id} where tenant_id = ${tenantId} and id = ${chapterId}`;
        }
      });
      evidence.push({ tool: id, input, output: out });
      return out;
    } catch (e) {
      await d.inTenant(tenantId, async (tx) => {
        await logCall(tx, id, input, verdict, 'error', now() - t0);
        await tx`insert into public.failures (tenant_id, turn_id, kind, severity, payload)
                 values (${tenantId}, ${turnId}, 'tool_error', 3, ${tx.json({ tool: id, error: String(e) } as never)})`;
      }).catch(() => {});                                              // logging must not hide the tool error
      return { error: 'tool_unavailable' };                            // the model explains or hands off
    }
  }

  const agentTools = principal.type === 'Agent' ? bundle.agents[principal.id]?.tools ?? [] : [];
  const tools: Record<string, Tool> = Object.fromEntries(agentTools.filter((id) => bundle.tools[id]).map((id) => {
    const c = bundle.tools[id]!;
    return [id, tool({ description: c.description, inputSchema: jsonSchema<Record<string, unknown>>(modelSchema(c.input) as JSONSchema7), execute: (input) => call(id, input) })];
  }));

  return { tools, call, authorize, caller, evidence: () => [...evidence] };
}

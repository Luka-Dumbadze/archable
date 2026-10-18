// packages/gateway/src/cedar.ts: cedarDecide, unchanged from v3 §7.1. Cedar is the only authority (I3), and any
// failure denies: a request that doesn't match the compiled schema (cedar_failure) and any evaluation error
// (policy_error), because Cedar skips a policy whose evaluation errors, which would turn a broken forbid into an allow.
import type { Bundle } from '@archable/compiler';
import { isAuthorized, type Context, type Schema } from '@cedar-policy/cedar-wasm/nodejs';

export interface Principal { type: 'Agent' | 'Trigger'; id: string }
export interface Verdict { allow: boolean; reasons: string[] }

export function cedarDecide(policies: Bundle['policies'], principal: Principal, action: string, context: Record<string, unknown>): Verdict {
  try {
    const answer = isAuthorized({
      principal, action: { type: 'Action', id: action }, resource: { type: 'Tool', id: action },
      context: context as Context,
      policies: { staticPolicies: policies.byId },             // Record<@id, text>, so reasons name real policies
      entities: [],
      ...(policies.schema ? { schema: policies.schema as Schema, validateRequest: true } : {}),
    });
    if (answer.type !== 'success') return { allow: false, reasons: ['cedar_failure'] };
    if (answer.response.diagnostics.errors.length > 0) return { allow: false, reasons: ['policy_error'] };
    return { allow: answer.response.decision === 'allow', reasons: answer.response.diagnostics.reason };
  } catch {
    return { allow: false, reasons: ['cedar_failure'] };
  }
}

type CedarType = { type: string; attributes?: Record<string, CedarType & { required?: boolean }>; element?: CedarType };

/** The context type the compiled schema declares for an action, or null when the bundle has no schema. */
export function contextType(policies: Bundle['policies'], action: string): CedarType | null {
  const schema = policies.schema as { ''?: { actions?: Record<string, { appliesTo: { context: CedarType } }> } } | null;
  return schema?.['']?.actions?.[action]?.appliesTo.context ?? null;
}

/**
 * Keeps exactly what the schema declares, recursively, and drops null and undefined. Callers pass richer objects
 * (Signals carry p and answeredBy; records carry every attribute), and Cedar rejects undeclared attributes.
 * A required attribute that is missing stays missing, so Cedar rejects the request, which denies.
 */
export function project(t: CedarType | null, value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (!t) return value;
  if (t.type === 'Record' && t.attributes) {
    if (typeof value !== 'object' || Array.isArray(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [k, at] of Object.entries(t.attributes)) {
      const v = project(at, (value as Record<string, unknown>)[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (t.type === 'Set' && Array.isArray(value)) return value.map((v) => project(t.element ?? null, v)).filter((v) => v !== undefined);
  return value;
}

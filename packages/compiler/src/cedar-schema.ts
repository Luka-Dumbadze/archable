// packages/compiler/src/cedar-schema.ts: the Cedar schema, the generated permits and the facts plan (plan §4.3, §5.5).
// Policies are validated at compile time against a schema generated from the spec, and the Tool Gateway builds
// each request's context from the facts plan emitted here, so both sides read one definition (v3 §6.1).
//
// Context of a tool action:
//   input      the tool's input; an optional input whose field has a default is filled with it, so it is required
//   approvals  Set<String> of approvals present for this call ([] until staff approvals exist)
//   quote      the order.quote output, when the action's policies read context.quote
//   <object>   a record of that object, when the action's policies read context.<object>: its fields, plus
//              <ref>_<key> for every ref field (order.customer → customer_phone). Optional when the tool writes that
//              object, since the record may not exist yet (Q8).
// Context of message.send: payload_digest and signals.<head> = {verdict, payload_digest} per pre-send decision.
import type { Field, Spec } from '@archable/schema';
import { validate, type Schema } from '@cedar-policy/cedar-wasm/nodejs';
import type { ParsedPolicy } from './cedar';
import type { Errors } from './errors';
import { BUILTIN_TOOLS } from './resolve';

type CedarType =
  | { type: 'String' } | { type: 'Long' } | { type: 'Boolean' }
  | { type: 'Set'; element: CedarType }
  | { type: 'Record'; attributes: Record<string, CedarAttr> };
type CedarAttr = CedarType & { required?: false };

export interface FactLoad { attr: string; object: string; via: string; by: 'id' | 'key' }
export interface ActionFacts {
  objects: FactLoad[];                                       // records the gateway loads into context.<attr>
  defaults: Record<string, string | number | boolean>;       // input defaults the gateway fills before Cedar
  keyInputs: Record<string, string>;                         // input → the object whose key it is ('phone' → 'customer')
  quote: boolean;                                            // the gateway prices the call into context.quote
}

export interface CedarArtifacts {
  schema: Record<string, unknown>;
  permits: Record<string, string>;                           // generated permit policies by id
  facts: Record<string, ActionFacts>;
}

const QUOTE_TOOL = 'order.quote';

const SCALAR: Record<string, CedarType> = {
  string: { type: 'String' }, phone: { type: 'String' }, date: { type: 'String' }, datetime: { type: 'String' },
  enum: { type: 'String' }, ref: { type: 'String' }, integer: { type: 'Long' }, money: { type: 'Long' }, boolean: { type: 'Boolean' },
};

const isRequired = (f: Field) => (!f.optional || f.default !== undefined) && !f.generated && !f.derived;
const attr = (t: CedarType, required: boolean): CedarAttr => (required ? t : { ...t, required: false });

function fieldType(f: Field): CedarType {
  if (f.type === 'list') return { type: 'Set', element: recordOf(f.of ?? {}) };
  return SCALAR[f.type]!;
}

function recordOf(fields: Record<string, Field>, extra: Record<string, CedarAttr> = {}): CedarType {
  const attributes: Record<string, CedarAttr> = {};
  for (const [name, f] of Object.entries(fields)) attributes[name] = attr(fieldType(f), isRequired(f));
  return { type: 'Record', attributes: { ...attributes, ...extra } };
}

/** A tool type expression ('order.lines', 'money?', 'customer', 'enum<a,b>') as a Cedar type; null if unknown. */
function exprType(spec: Spec, expr: string): CedarType | null {
  if (SCALAR[expr] && expr !== 'enum' && expr !== 'ref') return SCALAR[expr]!;
  if (/^enum<.+>$/.test(expr)) return { type: 'String' };
  let m = /^list<([a-z_]+)>$/.exec(expr);
  if (m && spec.objects[m[1]!]) return { type: 'Set', element: recordOf(spec.objects[m[1]!]!.fields) };
  m = /^([a-z_]+)\{([a-z_,]+)\}$/.exec(expr);
  if (m && spec.objects[m[1]!]) {
    const fields = spec.objects[m[1]!]!.fields;
    return { type: 'Record', attributes: Object.fromEntries(m[2]!.split(',').filter((n) => fields[n]).map((n) => [n, fieldType(fields[n]!)])) };
  }
  if (spec.objects[expr]) return { type: 'String' };          // a record, passed by id
  m = /^([a-z_]+)\.([a-z_]+)$/.exec(expr);
  const f = m && spec.objects[m[1]!]?.fields[m[2]!];
  return f ? fieldType(f) : null;
}

/** The field behind an input type expression, for its default. */
const exprField = (spec: Spec, expr: string): Field | undefined => {
  const m = /^([a-z_]+)\.([a-z_]+)$/.exec(expr);
  return m ? spec.objects[m[1]!]?.fields[m[2]!] : undefined;
};

/** A record of `object` as policies see it: its fields plus <ref>_<key> for each ref field. */
function factRecord(spec: Spec, object: string): CedarType {
  const fields = spec.objects[object]!.fields;
  const extra: Record<string, CedarAttr> = {};
  for (const [name, f] of Object.entries(fields)) {
    const target = f.type === 'ref' && f.to ? spec.objects[f.to] : undefined;
    if (target) extra[`${name}_${f.by ?? target.key}`] = attr({ type: 'String' }, isRequired(f));
  }
  return recordOf(fields, extra);
}

export function cedarArtifacts(spec: Spec, policies: ParsedPolicy[], errors: Errors): CedarArtifacts {
  const actions: Record<string, unknown> = {};
  const facts: Record<string, ActionFacts> = {};
  const appliesTo = (context: CedarType) => ({ principalTypes: ['Agent', 'Trigger'], resourceTypes: ['Tool'], context });

  for (const [id, tool] of Object.entries(spec.tools)) {
    const where = `tools.${id}`;
    const reads = new Set(policies.filter((p) => p.action === id).flatMap((p) => p.contextPaths.map((c) => c.split('.')[1]!)));

    const input: Record<string, CedarAttr> = {};
    const defaults: ActionFacts['defaults'] = {};
    const keyInputs: ActionFacts['keyInputs'] = {};
    for (const [name, raw] of Object.entries(tool.input)) {
      const optional = raw.endsWith('?');
      const expr = optional ? raw.slice(0, -1) : raw;
      const [obj, field] = expr.split('.');
      if (obj && field && spec.objects[obj]?.key === field) keyInputs[name] = obj;
      const t = exprType(spec, expr);
      if (!t) continue;                                       // reported by lower()
      const def = optional ? exprField(spec, expr)?.default : undefined;
      if (def !== undefined) defaults[name] = def;
      input[name] = attr(t, !optional || def !== undefined);
    }

    const context: Record<string, CedarAttr> = {
      input: { type: 'Record', attributes: input },
      approvals: { type: 'Set', element: { type: 'String' } },
    };
    const quote = reads.has('quote');
    if (quote) {
      const out = spec.tools[QUOTE_TOOL]?.output;
      if (!out) errors.add(where, `policies read context.quote but there is no ${QUOTE_TOOL} tool to price it`);
      else context.quote = { type: 'Record', attributes: Object.fromEntries(Object.entries(out).map(([k, e]) => [k, exprType(spec, e.replace(/\?$/, '')) ?? { type: 'String' }])) };
    }

    const objects: FactLoad[] = [];
    for (const object of [...reads].filter((r) => spec.objects[r]).sort()) {
      const key = spec.objects[object]!.key;
      const via = Object.entries(tool.input).find(([, e]) => { const x = e.replace(/\?$/, ''); return x === object || x === `${object}.${key}`; });
      if (!via) {
        errors.add(where, `policies read context.${object} but no input of ${id} identifies a ${object}`);
        continue;
      }
      objects.push({ attr: object, object, via: via[0], by: via[1].replace(/\?$/, '') === object ? 'id' : 'key' });
      // A record of an object this tool writes may not exist yet (customer.upsert creates the customer): the attribute
      // is optional, so a policy must ask `context has <object>` and a new record isn't denied as a missing fact (Q8).
      const writesIt = (tool.writes ?? []).some((w) => w.split('.')[0] === object);
      context[object] = writesIt ? attr(factRecord(spec, object), false) : factRecord(spec, object);
    }
    facts[id] = { objects, defaults, keyInputs, quote };
    actions[id] = { appliesTo: appliesTo({ type: 'Record', attributes: context }) };
  }

  // message.send: the send guard reads the pre-send signals bound to the draft's digest.
  const heads = [...new Set(Object.values(spec.agents).flatMap((a) => a.decisions.pre_send ?? []))].sort();
  const signal: CedarType = { type: 'Record', attributes: { verdict: { type: 'String' }, payload_digest: { type: 'String' } } };
  for (const id of Object.keys(BUILTIN_TOOLS)) {
    actions[id] = { appliesTo: appliesTo({ type: 'Record', attributes: {
      payload_digest: { type: 'String' },
      signals: { type: 'Record', attributes: Object.fromEntries(heads.map((h) => [h.slice(h.indexOf('.') + 1), signal])) },
    } }) };
    facts[id] = { objects: [], defaults: {}, keyInputs: {}, quote: false };
  }

  // Policy files only forbid (spec policies.default: deny); permits come from agents.*.tools and triggers.
  const permits: Record<string, string> = {};
  for (const [id, a] of Object.entries(spec.agents).sort(([x], [y]) => (x < y ? -1 : 1))) {
    const list = [...new Set([...a.tools, ...Object.keys(BUILTIN_TOOLS)])].sort().map((t) => `Action::"${t}"`).join(', ');
    permits[`permit.agent.${id}`] = `permit (principal == Agent::"${id}", action in [${list}], resource);`;
  }
  for (const [id, t] of Object.entries(spec.triggers).sort(([x], [y]) => (x < y ? -1 : 1))) {
    permits[`permit.trigger.${id}`] = `permit (principal == Trigger::"${id}", action == Action::"${t.call}", resource);`;
  }

  const schema = { '': { entityTypes: { Agent: {}, Trigger: {}, Tool: {} }, actions } };

  const byId = { ...Object.fromEntries(policies.map((p) => [p.id, p.text])), ...permits };
  const v = validate({ schema: schema as unknown as Schema, policies: { staticPolicies: byId } });
  if (v.type === 'failure') for (const e of v.errors) errors.add('policies', e.message);
  else {
    for (const e of v.validationErrors) {
      const p = policies.find((x) => x.id === e.policyId);
      errors.add(p ? `${p.file}#${p.id}` : e.policyId, e.error.message);
    }
  }
  return { schema, permits, facts };
}
